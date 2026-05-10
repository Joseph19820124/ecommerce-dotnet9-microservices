using MassTransit;
using ECommerce.SharedKernel.Messaging;

namespace ECommerce.Order.Application.Sagas;

// ── Integration Events ────────────────────────────────────────────────────────

public sealed record OrderCreatedEvent(
    Guid OrderId,
    Guid CustomerId,
    IReadOnlyList<OrderItem> Items,
    decimal TotalAmount,
    string Currency) : IntegrationEvent;

public sealed record InventoryReservedEvent(Guid OrderId) : IntegrationEvent;
public sealed record InventoryReservationFailedEvent(Guid OrderId, string Reason) : IntegrationEvent;
public sealed record PaymentProcessedEvent(Guid OrderId, string TransactionId) : IntegrationEvent;
public sealed record PaymentFailedEvent(Guid OrderId, string Reason) : IntegrationEvent;
public sealed record InventoryReleasedEvent(Guid OrderId) : IntegrationEvent;

public sealed record OrderItem(Guid ProductId, int Quantity, decimal UnitPrice, string Currency);

// ── Commands (sent by Saga) ───────────────────────────────────────────────────

public sealed record ReserveInventoryCommand(Guid OrderId, IReadOnlyList<OrderItem> Items) : IntegrationEvent;
public sealed record ProcessPaymentCommand(Guid OrderId, decimal Amount, string Currency, Guid CustomerId) : IntegrationEvent;
public sealed record ReleaseInventoryCommand(Guid OrderId, IReadOnlyList<OrderItem> Items) : IntegrationEvent;
public sealed record UpdateOrderStatusCommand(Guid OrderId, string Status) : IntegrationEvent;

// ── Saga State ────────────────────────────────────────────────────────────────

public sealed class OrderSagaState : SagaStateMachineInstance
{
    public Guid CorrelationId { get; set; }
    public string CurrentState { get; set; } = default!;
    public Guid CustomerId { get; set; }
    public IReadOnlyList<OrderItem> Items { get; set; } = [];
    public decimal TotalAmount { get; set; }
    public string Currency { get; set; } = default!;
    public string? FailureReason { get; set; }
    public string? TransactionId { get; set; }
    public DateTime CreatedAt { get; set; }
}

// ── State Machine ─────────────────────────────────────────────────────────────

public sealed class OrderStateMachine : MassTransitStateMachine<OrderSagaState>
{
    public State Submitted { get; private set; } = default!;
    public State ReservingInventory { get; private set; } = default!;
    public State ProcessingPayment { get; private set; } = default!;
    public State Confirmed { get; private set; } = default!;
    public State Cancelled { get; private set; } = default!;

    public Event<OrderCreatedEvent> OrderCreated { get; private set; } = default!;
    public Event<InventoryReservedEvent> InventoryReserved { get; private set; } = default!;
    public Event<InventoryReservationFailedEvent> InventoryReservationFailed { get; private set; } = default!;
    public Event<PaymentProcessedEvent> PaymentProcessed { get; private set; } = default!;
    public Event<PaymentFailedEvent> PaymentFailed { get; private set; } = default!;

    public OrderStateMachine()
    {
        InstanceState(x => x.CurrentState);

        Event(() => OrderCreated, x => x.CorrelateById(ctx => ctx.Message.OrderId));
        Event(() => InventoryReserved, x => x.CorrelateById(ctx => ctx.Message.OrderId));
        Event(() => InventoryReservationFailed, x => x.CorrelateById(ctx => ctx.Message.OrderId));
        Event(() => PaymentProcessed, x => x.CorrelateById(ctx => ctx.Message.OrderId));
        Event(() => PaymentFailed, x => x.CorrelateById(ctx => ctx.Message.OrderId));

        Initially(
            When(OrderCreated)
                .Then(ctx =>
                {
                    ctx.Saga.CustomerId = ctx.Message.CustomerId;
                    ctx.Saga.Items = ctx.Message.Items;
                    ctx.Saga.TotalAmount = ctx.Message.TotalAmount;
                    ctx.Saga.Currency = ctx.Message.Currency;
                    ctx.Saga.CreatedAt = DateTime.UtcNow;
                })
                .Publish(ctx => new ReserveInventoryCommand(ctx.Saga.CorrelationId, ctx.Saga.Items))
                .TransitionTo(ReservingInventory));

        During(ReservingInventory,
            When(InventoryReserved)
                .Publish(ctx => new ProcessPaymentCommand(
                    ctx.Saga.CorrelationId,
                    ctx.Saga.TotalAmount,
                    ctx.Saga.Currency,
                    ctx.Saga.CustomerId))
                .TransitionTo(ProcessingPayment),

            When(InventoryReservationFailed)
                .Then(ctx => ctx.Saga.FailureReason = ctx.Message.Reason)
                .Publish(ctx => new UpdateOrderStatusCommand(ctx.Saga.CorrelationId, "Cancelled"))
                .TransitionTo(Cancelled));

        During(ProcessingPayment,
            When(PaymentProcessed)
                .Then(ctx => ctx.Saga.TransactionId = ctx.Message.TransactionId)
                .Publish(ctx => new UpdateOrderStatusCommand(ctx.Saga.CorrelationId, "Confirmed"))
                .TransitionTo(Confirmed)
                .Finalize(),

            When(PaymentFailed)
                .Then(ctx => ctx.Saga.FailureReason = ctx.Message.Reason)
                // Compensating action: release inventory
                .Publish(ctx => new ReleaseInventoryCommand(ctx.Saga.CorrelationId, ctx.Saga.Items))
                .Publish(ctx => new UpdateOrderStatusCommand(ctx.Saga.CorrelationId, "Cancelled"))
                .TransitionTo(Cancelled));

        SetCompletedWhenFinalized();
    }
}
