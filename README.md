# ECommerce — Enterprise .NET 9 Microservices

A production-ready e-commerce platform built with .NET 9, Vertical Slice Architecture, DDD, and CQRS.

[中文文档](./README.zh-CN.md) | [Architecture](./docs/architecture.md)

## Quick Start

```bash
cp .env.example .env
docker compose up -d
```

Services available after startup:

| Service | URL |
|---------|-----|
| API Gateway | http://localhost:5000 |
| Catalog API (Swagger) | http://localhost:8081/openapi |
| Order API (Swagger) | http://localhost:8083/openapi |
| Identity Server | http://localhost:8082 |
| RabbitMQ Management | http://localhost:15672 (guest/guest) |
| Kibana | http://localhost:5601 |
| PgAdmin | http://localhost:5050 |
| Zipkin | http://localhost:9411 |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | .NET 9, C# 13 |
| Architecture | Vertical Slice, DDD, CQRS |
| Result Pattern | ErrorOr 2.x |
| Messaging | MediatR 12, MassTransit 8, RabbitMQ |
| Validation | FluentValidation 11 |
| Identity | Duende IdentityServer 7 |
| Database | PostgreSQL 16, EF Core 9 |
| Search | Elasticsearch 8, NEST |
| Cache | Redis 7 |
| API Gateway | YARP 2.3 |
| Observability | Serilog, OpenTelemetry, Zipkin, Kibana |
| Frontend | Blazor Web App (Server+WASM), Next.js 13+ |
| i18n | en-US, zh-CN |

## Solution Structure

```
src/
├── SharedKernel/
│   └── ECommerce.SharedKernel/        # Abstractions, Base classes, Behaviors
├── Services/
│   ├── Catalog/                        # Product catalog + Elasticsearch
│   ├── Identity/                       # Duende IdentityServer + Users
│   ├── Inventory/                      # Stock management (gRPC server)
│   ├── Order/                          # Orders + MassTransit Saga
│   ├── Payment/                        # Payment stub + webhooks
│   └── Notification/                   # Email/SMS consumers
├── ApiGateway/
│   └── ECommerce.ApiGateway/           # YARP
└── Frontend/
    ├── ECommerce.Web.Blazor/           # Blazor SSR + WASM
    └── ecommerce-nextjs/               # Next.js 13+ App Router
tests/
docs/
docker-compose.yml
```

## Vertical Slice Example (CreateProduct)

```
Features/Products/CreateProduct.cs
├── CreateProductCommand    (ICommand<CreateProductResponse>)
├── CreateProductValidator  (AbstractValidator<CreateProductCommand>)
├── CreateProductHandler    (ICommandHandler<...>)
└── CreateProductEndpoint   (ICarterModule → POST /api/v1/products)
```

## Order Saga Flow

```
OrderCreated → ReserveInventory → ProcessPayment → Confirmed
                    ↓ (fail)           ↓ (fail)
                 Cancelled    ReleaseInventory → Cancelled
```

## Running Migrations

```bash
# Catalog
dotnet ef migrations add Init -p src/Services/Catalog/Catalog.Infrastructure -s src/Services/Catalog/Catalog.Api

# Order
dotnet ef migrations add Init -p src/Services/Order/Order.Infrastructure -s src/Services/Order/Order.Api
```
