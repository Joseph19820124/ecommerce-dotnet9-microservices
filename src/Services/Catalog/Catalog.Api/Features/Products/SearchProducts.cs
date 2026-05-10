using Carter;
using ECommerce.SharedKernel.Abstractions;
using ECommerce.Catalog.Domain.Repositories;
using ErrorOr;
using FluentValidation;
using MediatR;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace ECommerce.Catalog.Api.Features.Products;

// ── Query ─────────────────────────────────────────────────────────────────────

public sealed record SearchProductsQuery(
    string? SearchTerm,
    Guid? CategoryId,
    decimal? MinPrice,
    decimal? MaxPrice,
    int Page = 1,
    int PageSize = 20) : IQuery<SearchProductsResponse>;

public sealed record SearchProductsResponse(
    IReadOnlyList<ProductSummary> Items,
    int TotalCount,
    int Page,
    int PageSize,
    int TotalPages);

public sealed record ProductSummary(
    Guid Id,
    string Name,
    decimal Price,
    string Currency,
    Guid CategoryId,
    string Sku,
    bool IsActive);

// ── Validator ─────────────────────────────────────────────────────────────────

public sealed class SearchProductsValidator : AbstractValidator<SearchProductsQuery>
{
    public SearchProductsValidator()
    {
        RuleFor(x => x.Page).GreaterThan(0);
        RuleFor(x => x.PageSize).InclusiveBetween(1, 100);
        RuleFor(x => x.MinPrice).GreaterThanOrEqualTo(0).When(x => x.MinPrice.HasValue);
        RuleFor(x => x.MaxPrice).GreaterThan(x => x.MinPrice ?? 0).When(x => x.MaxPrice.HasValue);
    }
}

// ── Handler ───────────────────────────────────────────────────────────────────

public sealed class SearchProductsHandler(IProductRepository repository)
    : IQueryHandler<SearchProductsQuery, SearchProductsResponse>
{
    public async Task<ErrorOr<SearchProductsResponse>> Handle(
        SearchProductsQuery query,
        CancellationToken cancellationToken)
    {
        var (items, total) = await repository.SearchAsync(
            query.SearchTerm,
            query.CategoryId,
            query.MinPrice,
            query.MaxPrice,
            query.Page,
            query.PageSize,
            cancellationToken);

        var summaries = items.Select(p => new ProductSummary(
            p.Id.Value,
            p.Name,
            p.Price.Amount,
            p.Price.Currency,
            p.CategoryId,
            p.Sku,
            p.IsActive)).ToList();

        var totalPages = (int)Math.Ceiling(total / (double)query.PageSize);

        return new SearchProductsResponse(summaries, total, query.Page, query.PageSize, totalPages);
    }
}

// ── Endpoint ──────────────────────────────────────────────────────────────────

public sealed class SearchProductsEndpoint : ICarterModule
{
    public void AddRoutes(IEndpointRouteBuilder app)
    {
        app.MapGet("/api/v1/products", async (
            string? searchTerm,
            Guid? categoryId,
            decimal? minPrice,
            decimal? maxPrice,
            int page,
            int pageSize,
            ISender sender,
            CancellationToken ct) =>
        {
            var query = new SearchProductsQuery(searchTerm, categoryId, minPrice, maxPrice, page, pageSize);
            var result = await sender.Send(query, ct);

            return result.Match(
                Results.Ok,
                errors => Results.Problem(errors[0].Description));
        })
        .WithName("SearchProducts")
        .WithTags("Products")
        .WithSummary("Search products with filters")
        .Produces<SearchProductsResponse>();
    }
}
