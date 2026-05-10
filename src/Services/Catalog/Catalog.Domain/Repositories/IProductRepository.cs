using ECommerce.SharedKernel.Abstractions;
using ECommerce.Catalog.Domain.Entities;
using ECommerce.Catalog.Domain.ValueObjects;

namespace ECommerce.Catalog.Domain.Repositories;

public interface IProductRepository : IRepository<Product, ProductId>
{
    Task<bool> ExistsBySkuAsync(string sku, CancellationToken ct = default);
    Task<(IReadOnlyList<Product> Items, int TotalCount)> SearchAsync(
        string? searchTerm,
        Guid? categoryId,
        decimal? minPrice,
        decimal? maxPrice,
        int page,
        int pageSize,
        CancellationToken ct = default);
}
