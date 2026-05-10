# ECommerce Microservices — Architecture Document

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Client Layer                                │
│           Blazor Web App (SSR+WASM)    Next.js 13+ App Router       │
└──────────────────────┬──────────────────────────┬───────────────────┘
                       │ HTTPS                    │ HTTPS
┌──────────────────────▼──────────────────────────▼───────────────────┐
│                      YARP API Gateway (:5000)                       │
│         JWT validation · Rate limiting · Routing · CORS             │
└────┬──────────┬────────────┬───────────┬──────────┬─────────────────┘
     │          │            │           │          │
  REST       REST          REST        REST       REST
     │          │            │           │          │
┌────▼──┐  ┌───▼────┐  ┌───▼────┐  ┌──▼─────┐ ┌──▼──────┐
│Catalog│  │Identity│  │ Order  │  │Inventory│ │Payment  │
│  API  │  │  API   │  │  API   │  │  API    │ │  API    │
│:8081  │  │:8082   │  │:8083   │  │:8084    │ │:8085    │
└───┬───┘  └───┬────┘  └───┬────┘  └──┬──────┘ └──┬──────┘
    │           │           │          │            │
    │      Duende IS   MassTransit Saga            │
    │           │        (RabbitMQ)                │
    │      ┌────▼────┐  ┌──▼──────────────────────▼────────┐
    │      │Postgres │  │           RabbitMQ                │
    │      │identity │  │  Exchanges · Queues · Outbox      │
    │      └─────────┘  └───────────────────────────────────┘
    │
┌───▼─────────────────────┐   ┌────────────┐   ┌───────────────┐
│   Elasticsearch         │   │   Redis    │   │  PostgreSQL   │
│  (product full-text,    │   │  (cache,   │   │ (catalog,     │
│   aggregations)         │   │  sessions) │   │  order,       │
└─────────────────────────┘   └────────────┘   │  inventory,   │
                                               │  payment)     │
                                               └───────────────┘

Observability: Zipkin (distributed tracing) · Kibana (logs)
```

## Bounded Contexts & Responsibilities

| Service | Port | DB Schema | Key Responsibilities |
|---------|------|-----------|---------------------|
| Identity | 8082 | identity | OAuth2/OIDC via Duende, User management |
| Catalog | 8081 | catalog | Products, Categories, ES sync |
| Inventory | 8084 | inventory | Stock levels, Reservations (gRPC) |
| Order | 8083 | order | Cart, Orders, Saga orchestration |
| Payment | 8085 | payment | Payment stub, Webhook callbacks |
| Notification | 8086 | — | Email/SMS via MassTransit consumer |
| API Gateway | 5000 | — | YARP routing, Auth forwarding |

## Vertical Slice Architecture

Each feature lives in a single file:

```
Features/
└── Products/
    └── CreateProduct.cs        ← Command + Validator + Handler + Endpoint
    └── SearchProducts.cs       ← Query + Validator + Handler + Endpoint
    └── GetProductById.cs
    └── UpdateProductPrice.cs
    └── DeactivateProduct.cs
```

**Data flow per slice:**
```
HTTP Request
    → Carter Endpoint
        → ISender.Send(Command/Query)
            → ValidationBehavior (FluentValidation)
                → LoggingBehavior
                    → PerformanceBehavior
                        → Handler → ErrorOr<T>
    → Result.Match(ok, errors) → IResult
```

## Order Saga State Machine

```
[Initial]
    │
    ▼ OrderCreatedEvent
[ReservingInventory] ──── InventoryReservationFailed ──→ [Cancelled]
    │                                                         ▲
    ▼ InventoryReservedEvent                                  │
[ProcessingPayment] ─────── PaymentFailed ────────────────────┤
    │                       (+ ReleaseInventory compensate)   │
    ▼ PaymentProcessedEvent                                   │
[Confirmed/Final]                                             │
```

**Compensating Actions:**
- `PaymentFailed` → publish `ReleaseInventoryCommand` → restore stock
- `InventoryReservationFailed` → publish `UpdateOrderStatusCommand("Cancelled")`

## Result Pattern (ErrorOr)

```csharp
// Handler always returns ErrorOr<T>
public async Task<ErrorOr<CreateProductResponse>> Handle(...)
{
    if (skuExists) return Error.Conflict("...");   // early return errors
    var product = Product.Create(...);
    if (product.IsError) return product.Errors;    // propagate domain errors
    return new CreateProductResponse(...);          // happy path
}

// Endpoint always uses .Match()
return result.Match(
    response => Results.Created(..., response),
    errors   => Results.Problem(errors[0].Description, statusCode: MapToStatus(errors)));
```

## Domain Model (Catalog)

```
Product (AggregateRoot<ProductId>)
├── ProductId       (ValueObject, wraps Guid)
├── Money           (ValueObject, Amount + Currency)
├── CategoryId      (Guid FK to Category aggregate)
├── Sku             (string, unique index)
└── DomainEvents[]
    ├── ProductCreatedEvent
    ├── ProductPriceChangedEvent
    └── ProductDeactivatedEvent
```

## Communication Patterns

| Pattern | Used For |
|---------|----------|
| REST (YARP → Service) | External client requests |
| gRPC | Inventory stock-check from Order service (sync, low-latency) |
| MassTransit/RabbitMQ | Async domain events between services |
| MassTransit Saga | Order workflow orchestration |
| MassTransit Outbox | At-least-once delivery guarantee |

## Internationalization

- Supported cultures: `en-US`, `zh-CN`
- Backend: `IStringLocalizer<T>` with `.resx` resource files per feature
- Frontend Blazor: `IStringLocalizer` + satellite assemblies
- Frontend Next.js: `next-intl` with `messages/en.json` + `messages/zh.json`
- Culture negotiation: `Accept-Language` header → `RequestLocalizationMiddleware`
