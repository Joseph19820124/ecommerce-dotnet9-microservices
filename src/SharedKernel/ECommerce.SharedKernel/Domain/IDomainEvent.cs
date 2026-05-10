using MediatR;

namespace ECommerce.SharedKernel.Domain;

public interface IDomainEvent : INotification
{
    Guid EventId { get; }
    DateTime OccurredOn { get; }
}
