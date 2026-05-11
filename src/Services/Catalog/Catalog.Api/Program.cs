using Carter;
using ECommerce.Catalog.Infrastructure;
using ECommerce.SharedKernel.Extensions;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using Serilog;
using System.Reflection;

var builder = WebApplication.CreateBuilder(args);


builder.Host.UseSerilog((ctx, cfg) =>
    cfg.ReadFrom.Configuration(ctx.Configuration)
       .Enrich.WithProperty("Service", "catalog-api"));

builder.Services.AddSharedKernel(Assembly.GetExecutingAssembly());
builder.Services.AddCarter();
builder.Services.AddLocalization(opts => opts.ResourcesPath = "Localization/Resources");
builder.Services.AddOpenApi();

builder.Services
    .AddAuthentication("Bearer")
    .AddJwtBearer("Bearer", opts =>
    {
        opts.Authority = builder.Configuration["Authentication:Authority"];
        opts.Audience = builder.Configuration["Authentication:Audience"];
        opts.RequireHttpsMetadata = !builder.Environment.IsDevelopment();
    });

builder.Services.AddAuthorization(opts =>
    opts.AddPolicy("AdminPolicy", p => p.RequireClaim("role", "admin")));

builder.Services.AddCatalogInfrastructure(builder.Configuration);

// AWS X-Ray via OpenTelemetry OTLP → X-Ray daemon sidecar (UDP 2000)
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing => tracing
        .SetResourceBuilder(ResourceBuilder.CreateDefault()
            .AddService("catalog-api")
            .AddTelemetrySdk())
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddEntityFrameworkCoreInstrumentation()
        .AddOtlpExporter(opts =>                // ship to X-Ray daemon (ADOT sidecar)
            opts.Endpoint = new Uri(
                builder.Configuration["OpenTelemetry:OtlpEndpoint"]
                    ?? "http://localhost:4317")));

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
app.MapHealthChecks("/health");

app.Run();
