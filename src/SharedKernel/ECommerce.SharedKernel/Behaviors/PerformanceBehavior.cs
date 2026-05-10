using System.Diagnostics;
using MediatR;
using Microsoft.Extensions.Logging;

namespace ECommerce.SharedKernel.Behaviors;

public sealed class PerformanceBehavior<TRequest, TResponse>(
    ILogger<PerformanceBehavior<TRequest, TResponse>> logger)
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : IRequest<TResponse>
{
    private const int SlowRequestThresholdMs = 500;

    public async Task<TResponse> Handle(
        TRequest request,
        RequestHandlerDelegate<TResponse> next,
        CancellationToken cancellationToken)
    {
        var sw = Stopwatch.StartNew();
        var response = await next();
        sw.Stop();

        if (sw.ElapsedMilliseconds > SlowRequestThresholdMs)
            logger.LogWarning(
                "Slow request detected: {RequestName} took {ElapsedMs}ms",
                typeof(TRequest).Name,
                sw.ElapsedMilliseconds);

        return response;
    }
}
