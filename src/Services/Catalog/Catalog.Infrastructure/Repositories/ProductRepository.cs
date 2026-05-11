using ECommerce.Catalog.Domain.Entities;
using ECommerce.Catalog.Domain.Repositories;
using ECommerce.Catalog.Domain.ValueObjects;
using ECommerce.Catalog.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace ECommerce.Catalog.Infrastructure.Repositories;

public sealed class ProductRepository(CatalogDbContext db) : IProductRepository
{
    public async Task<Product?> GetByIdAsync(ProductId id, CancellationToken ct = default) =>
        await db.Products.FirstOrDefaultAsync(p => p.Id == id, ct);

    public async Task AddAsync(Product aggregate, CancellationToken ct = default) =>
        await db.Products.AddAsync(aggregate, ct);

    public void Update(Product aggregate) => db.Products.Update(aggregate);

    public void Remove(Product aggregate) => db.Products.Remove(aggregate);

    public async Task<bool> ExistsBySkuAsync(string sku, CancellationToken ct = default) =>
        await db.Products.AnyAsync(p => p.Sku == sku, ct);

    public async Task<(IReadOnlyList<Product> Items, int TotalCount)> SearchAsync(
        string? searchTerm, Guid? categoryId, decimal? minPrice, decimal? maxPrice,
        int page, int pageSize, CancellationToken ct = default)
    {
        var query = db.Products.AsQueryable();

        if (!string.IsNullOrWhiteSpace(searchTerm))
            query = query.Where(p => p.Name.Contains(searchTerm) || p.Description.Contains(searchTerm));
        if (categoryId.HasValue)
            query = query.Where(p => p.CategoryId == categoryId.Value);
        if (minPrice.HasValue)
            query = query.Where(p => p.Price.Amount >= minPrice.Value);
        if (maxPrice.HasValue)
            query = query.Where(p => p.Price.Amount <= maxPrice.Value);

        var total = await query.CountAsync(ct);
        var items = await query
            .OrderByDescending(p => p.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .ToListAsync(ct);

        return (items, total);
    }
}
