using Carter;
using ECommerce.SharedKernel.Extensions;
using Serilog;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using System.Reflection;

var builder = WebApplication.CreateBuilder(args);

builder.Host.UseSerilog((ctx, cfg) =>
    cfg.ReadFrom.Configuration(ctx.Configuration));

// MediatR + FluentValidation + Pipeline Behaviors
builder.Services.AddSharedKernel(Assembly.GetExecutingAssembly());

// Carter (Minimal API endpoint discovery)
builder.Services.AddCarter();

// Localization
builder.Services.AddLocalization(opts => opts.ResourcesPath = "Localization/Resources");

// Swagger / OpenAPI
builder.Services.AddOpenApi();

// Auth
builder.Services.AddAuthentication("Bearer")
    .AddJwtBearer("Bearer", opts =>
    {
        opts.Authority = builder.Configuration["Authentication:Authority"];
        opts.Audience = builder.Configuration["Authentication:Audience"];
        opts.RequireHttpsMetadata = false;
    });

builder.Services.AddAuthorization(opts =>
    opts.AddPolicy("AdminPolicy", p => p.RequireClaim("role", "admin")));

// Infrastructure (EF Core, Redis, Elasticsearch, MassTransit) — registered via extension
builder.Services.AddCatalogInfrastructure(builder.Configuration);

// OpenTelemetry
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing => tracing
        .SetResourceBuilder(ResourceBuilder.CreateDefault().AddService("catalog-api"))
        .AddAspNetCoreInstrumentation()
        .AddEntityFrameworkCoreInstrumentation()
        .AddZipkinExporter(opts =>
            opts.Endpoint = new Uri(builder.Configuration["Zipkin:Endpoint"]!)));

var app = builder.Build();

var supportedCultures = new[] { "en-US", "zh-CN" };
app.UseRequestLocalization(new RequestLocalizationOptions()
    .SetDefaultCulture("en-US")
    .AddSupportedCultures(supportedCultures)
    .AddSupportedUICultures(supportedCultures));

if (app.Environment.IsDevelopment())
    app.MapOpenApi();

app.UseSerilogRequestLogging();
app.UseAuthentication();
app.UseAuthorization();
app.MapCarter();

app.Run();
