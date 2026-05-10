using ECommerce.SharedKernel.Domain;

namespace ECommerce.Catalog.Domain.Events;

public sealed record ProductCreatedEvent(Guid ProductId, string Name) : DomainEvent;

public sealed record ProductPriceChangedEvent(Guid ProductId, decimal NewPrice, string Currency) : DomainEvent;

public sealed record ProductDeactivatedEvent(Guid ProductId) : DomainEvent;
