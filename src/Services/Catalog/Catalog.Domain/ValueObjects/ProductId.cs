using ECommerce.SharedKernel.Primitives;

namespace ECommerce.Catalog.Domain.ValueObjects;

public sealed class ProductId : ValueObject
{
    private ProductId(Guid value) => Value = value;

    public Guid Value { get; }

    public static ProductId Create(Guid value) => new(value);
    public static ProductId CreateUnique() => new(Guid.NewGuid());

    protected override IEnumerable<object?> GetEqualityComponents()
    {
        yield return Value;
    }

    public override string ToString() => Value.ToString();
}
