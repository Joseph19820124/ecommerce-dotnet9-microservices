using ErrorOr;
using MediatR;

namespace ECommerce.SharedKernel.Abstractions;

public interface IQuery<TResponse> : IRequest<ErrorOr<TResponse>> { }

public interface IQueryHandler<TQuery, TResponse> : IRequestHandler<TQuery, ErrorOr<TResponse>>
    where TQuery : IQuery<TResponse> { }
