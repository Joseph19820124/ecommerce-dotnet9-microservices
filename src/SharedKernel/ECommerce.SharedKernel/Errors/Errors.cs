using ErrorOr;

namespace ECommerce.SharedKernel.Errors;

public static class SharedErrors
{
    public static class General
    {
        public static Error NotFound(string resource, object id) =>
            Error.NotFound("General.NotFound", $"{resource} with id '{id}' was not found.");

        public static Error Conflict(string description) =>
            Error.Conflict("General.Conflict", description);

        public static Error Unauthorized() =>
            Error.Unauthorized("General.Unauthorized", "You are not authorized.");

        public static Error Validation(string description) =>
            Error.Validation("General.Validation", description);

        public static Error Unexpected() =>
            Error.Unexpected("General.Unexpected", "An unexpected error occurred.");
    }
}
