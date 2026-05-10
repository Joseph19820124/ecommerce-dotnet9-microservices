using Carter;
using ECommerce.SharedKernel.Abstractions;
using ECommerce.Catalog.Domain.Entities;
using ECommerce.Catalog.Domain.Repositories;
using ECommerce.SharedKernel.Abstractions;
using ErrorOr;
using FluentValidation;
using MediatR;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Localization;

namespace ECommerce.Catalog.Api.Features.Products;

// ── Command ──────────────────────────────────────────────────────────────────

public sealed record CreateProductCommand(
    string Name,
    string Description,
    decimal Price,
    string Currency,
    Guid CategoryId,
    string Sku) : ICommand<CreateProductResponse>;

public sealed record CreateProductResponse(Guid ProductId, string Name, decimal Price, string Currency);

// ── Validator ─────────────────────────────────────────────────────────────────

public sealed class CreateProductValidator : AbstractValidator<CreateProductCommand>
{
    public CreateProductValidator(IStringLocalizer<CreateProductValidator> localizer)
    {
        RuleFor(x => x.Name)
            .NotEmpty().WithMessage(localizer["Name_Required"])
            .MaximumLength(200).WithMessage(localizer["Name_MaxLength"]);

        RuleFor(x => x.Price)
            .GreaterThan(0).WithMessage(localizer["Price_Positive"]);

        RuleFor(x => x.Currency)
            .NotEmpty()
            .Must(c => new[] { "USD", "CNY", "EUR" }.Contains(c.ToUpperInvariant()))
            .WithMessage(localizer["Currency_Invalid"]);

        RuleFor(x => x.CategoryId)
            .NotEmpty().WithMessage(localizer["CategoryId_Required"]);

        RuleFor(x => x.Sku)
            .NotEmpty().WithMessage(localizer["Sku_Required"])
            .MaximumLength(50).WithMessage(localizer["Sku_MaxLength"]);
    }
}

// ── Handler ───────────────────────────────────────────────────────────────────

public sealed class CreateProductHandler(
    IProductRepository repository,
    IUnitOfWork unitOfWork)
    : ICommandHandler<CreateProductCommand, CreateProductResponse>
{
    public async Task<ErrorOr<CreateProductResponse>> Handle(
        CreateProductCommand command,
        CancellationToken cancellationToken)
    {
        if (await repository.ExistsBySkuAsync(command.Sku, cancellationToken))
            return Error.Conflict("Product.Sku", $"SKU '{command.Sku}' already exists.");

        var productResult = Product.Create(
            command.Name,
            command.Description,
            command.Price,
            command.Currency,
            command.CategoryId,
            command.Sku);

        if (productResult.IsError) return productResult.Errors;

        await repository.AddAsync(productResult.Value, cancellationToken);
        await unitOfWork.SaveChangesAsync(cancellationToken);

        var p = productResult.Value;
        return new CreateProductResponse(p.Id.Value, p.Name, p.Price.Amount, p.Price.Currency);
    }
}

// ── Endpoint (Carter) ─────────────────────────────────────────────────────────

public sealed class CreateProductEndpoint : ICarterModule
{
    public void AddRoutes(IEndpointRouteBuilder app)
    {
        app.MapPost("/api/v1/products", async (
            CreateProductRequest request,
            ISender sender,
            CancellationToken ct) =>
        {
            var command = new CreateProductCommand(
                request.Name,
                request.Description,
                request.Price,
                request.Currency,
                request.CategoryId,
                request.Sku);

            var result = await sender.Send(command, ct);

            return result.Match(
                response => Results.Created($"/api/v1/products/{response.ProductId}", response),
                errors => Results.Problem(
                    title: errors[0].Description,
                    statusCode: errors[0].Type switch
                    {
                        ErrorType.Conflict => StatusCodes.Status409Conflict,
                        ErrorType.Validation => StatusCodes.Status400BadRequest,
                        _ => StatusCodes.Status500InternalServerError
                    }));
        })
        .WithName("CreateProduct")
        .WithTags("Products")
        .WithSummary("Create a new product")
        .Produces<CreateProductResponse>(StatusCodes.Status201Created)
        .ProducesValidationProblem()
        .RequireAuthorization("AdminPolicy");
    }
}

// ── Request DTO ───────────────────────────────────────────────────────────────

public sealed record CreateProductRequest(
    string Name,
    string Description,
    decimal Price,
    string Currency,
    Guid CategoryId,
    string Sku);
