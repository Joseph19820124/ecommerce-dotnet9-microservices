using ECommerce.SharedKernel.Primitives;
using ErrorOr;

namespace ECommerce.Catalog.Domain.ValueObjects;

public sealed class Money : ValueObject
{
    private static readonly HashSet<string> SupportedCurrencies = ["USD", "CNY", "EUR"];

    private Money(decimal amount, string currency)
    {
        Amount = amount;
        Currency = currency;
    }

    public decimal Amount { get; }
    public string Currency { get; }

    public static ErrorOr<Money> Create(decimal amount, string currency)
    {
        if (amount < 0)
            return Error.Validation("Money.Amount", "Amount cannot be negative.");

        if (!SupportedCurrencies.Contains(currency.ToUpperInvariant()))
            return Error.Validation("Money.Currency", $"Currency '{currency}' is not supported.");

        return new Money(amount, currency.ToUpperInvariant());
    }

    public Money Add(Money other)
    {
        if (Currency != other.Currency)
            throw new InvalidOperationException("Cannot add money with different currencies.");
        return new Money(Amount + other.Amount, Currency);
    }

    protected override IEnumerable<object?> GetEqualityComponents()
    {
        yield return Amount;
        yield return Currency;
    }

    public override string ToString() => $"{Amount:F2} {Currency}";
}
