using ECommerce.SharedKernel.Domain;
using ECommerce.SharedKernel.Primitives;
using ECommerce.Catalog.Domain.ValueObjects;
using ECommerce.Catalog.Domain.Events;
using ErrorOr;

namespace ECommerce.Catalog.Domain.Entities;

public sealed class Product : AggregateRoot<ProductId>
{
    private Product() : base(ProductId.Create(Guid.Empty)) { }

    private Product(
        ProductId id,
        string name,
        string description,
        Money price,
        Guid categoryId,
        string sku) : base(id)
    {
        Name = name;
        Description = description;
        Price = price;
        CategoryId = categoryId;
        Sku = sku;
        IsActive = true;
        CreatedAt = DateTime.UtcNow;
    }

    public string Name { get; private set; } = default!;
    public string Description { get; private set; } = default!;
    public Money Price { get; private set; } = default!;
    public Guid CategoryId { get; private set; }
    public string Sku { get; private set; } = default!;
    public bool IsActive { get; private set; }
    public DateTime CreatedAt { get; private set; }
    public DateTime? UpdatedAt { get; private set; }

    public static ErrorOr<Product> Create(
        string name,
        string description,
        decimal price,
        string currency,
        Guid categoryId,
        string sku)
    {
        var moneyResult = Money.Create(price, currency);
        if (moneyResult.IsError) return moneyResult.Errors;

        if (string.IsNullOrWhiteSpace(name))
            return Error.Validation("Product.Name", "Name cannot be empty.");

        if (string.IsNullOrWhiteSpace(sku))
            return Error.Validation("Product.Sku", "SKU cannot be empty.");

        var product = new Product(
            ProductId.CreateUnique(),
            Guard.AgainstLength(name, 200, nameof(name)),
            description,
            moneyResult.Value,
            categoryId,
            sku);

        product.RaiseDomainEvent(new ProductCreatedEvent(product.Id.Value, product.Name));
        return product;
    }

    public ErrorOr<Success> UpdatePrice(decimal newPrice, string currency)
    {
        var moneyResult = Money.Create(newPrice, currency);
        if (moneyResult.IsError) return moneyResult.Errors;

        Price = moneyResult.Value;
        UpdatedAt = DateTime.UtcNow;
        RaiseDomainEvent(new ProductPriceChangedEvent(Id.Value, newPrice, currency));
        return Result.Success;
    }

    public void Deactivate()
    {
        IsActive = false;
        UpdatedAt = DateTime.UtcNow;
    }
}
