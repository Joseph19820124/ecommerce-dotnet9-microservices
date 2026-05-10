using ErrorOr;
using MediatR;

namespace ECommerce.SharedKernel.Abstractions;

public interface ICommand : IRequest<ErrorOr<Success>> { }

public interface ICommand<TResponse> : IRequest<ErrorOr<TResponse>> { }

public interface ICommandHandler<TCommand> : IRequestHandler<TCommand, ErrorOr<Success>>
    where TCommand : ICommand { }

public interface ICommandHandler<TCommand, TResponse> : IRequestHandler<TCommand, ErrorOr<TResponse>>
    where TCommand : ICommand<TResponse> { }
