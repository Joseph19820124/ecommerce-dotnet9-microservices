namespace ECommerce.SharedKernel.Primitives;

public static class Guard
{
    public static T AgainstNull<T>(T? value, string paramName)
    {
        ArgumentNullException.ThrowIfNull(value, paramName);
        return value;
    }

    public static string AgainstNullOrWhiteSpace(string? value, string paramName)
    {
        if (string.IsNullOrWhiteSpace(value))
            throw new ArgumentException($"'{paramName}' cannot be null or whitespace.", paramName);
        return value;
    }

    public static string AgainstLength(string value, int maxLength, string paramName)
    {
        if (value.Length > maxLength)
            throw new ArgumentException($"'{paramName}' cannot exceed {maxLength} characters.", paramName);
        return value;
    }

    public static decimal AgainstNegative(decimal value, string paramName)
    {
        if (value < 0)
            throw new ArgumentException($"'{paramName}' cannot be negative.", paramName);
        return value;
    }

    public static int AgainstNegativeOrZero(int value, string paramName)
    {
        if (value <= 0)
            throw new ArgumentException($"'{paramName}' must be greater than zero.", paramName);
        return value;
    }
}
