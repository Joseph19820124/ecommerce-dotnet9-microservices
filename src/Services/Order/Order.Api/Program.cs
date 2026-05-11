using Carter;
using ECommerce.Order.Application.Sagas;
using ECommerce.SharedKernel.Extensions;
using MassTransit;
using OpenTelemetry.Contrib.Instrumentation.AWSXRay.Implementation;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using Serilog;
using System.Reflection;

var builder = WebApplication.CreateBuilder(args);

if (!builder.Environment.IsDevelopment())
{
    builder.Configuration.AddSystemsManager(
        $"/ecommerce/{builder.Environment.EnvironmentName}/order",
        TimeSpan.FromMinutes(5));
}

builder.Host.UseSerilog((ctx, cfg) =>
    cfg.ReadFrom.Configuration(ctx.Configuration)
       .Enrich.WithProperty("Service", "order-api"));

builder.Services.AddSharedKernel(
    Assembly.GetExecutingAssembly(),
    typeof(OrderStateMachine).Assembly);

builder.Services.AddCarter();
builder.Services.AddLocalization(opts => opts.ResourcesPath = "Localization/Resources");
builder.Services.AddOpenApi();

builder.Services.AddAuthentication("Bearer")
    .AddJwtBearer("Bearer", opts =>
    {
        opts.Authority = builder.Configuration["Authentication:Authority"];
        opts.Audience = builder.Configuration["Authentication:Audience"];
        opts.RequireHttpsMetadata = !builder.Environment.IsDevelopment();
    });
builder.Services.AddAuthorization();

// MassTransit + Amazon SQS/SNS (replaces RabbitMQ — no broker needed, IAM via ECS task role)
builder.Services.AddMassTransit(cfg =>
{
    cfg.AddSagaStateMachine<OrderStateMachine, OrderSagaState>()
        .EntityFrameworkRepository(r =>
        {
            r.ConcurrencyMode = ConcurrencyMode.Pessimistic;
            r.AddDbContext<DbContext, OrderSagaDbContext>((provider, options) =>
                options.UseNpgsql(builder.Configuration.GetConnectionString("OrderDb")));
        });

    cfg.AddEntityFrameworkOutbox<OrderDbContext>(o =>
    {
        o.UsePostgres();
        o.UseBusOutbox();
    });

    cfg.UsingAmazonSqs((ctx, sqs) =>
    {
        // Region from environment; credentials from ECS task role (no keys needed)
        sqs.Host(builder.Configuration["AWS:Region"] ?? "us-east-1");

        sqs.UseMessageRetry(r => r.Exponential(5,
            TimeSpan.FromSeconds(1),
            TimeSpan.FromSeconds(60),
            TimeSpan.FromSeconds(5)));

        sqs.ConfigureEndpoints(ctx);
    });
});

builder.Services.AddOpenTelemetry()
    .WithTracing(tracing => tracing
        .SetResourceBuilder(ResourceBuilder.CreateDefault().AddService("order-api"))
        .AddXRayTraceId()
        .AddAspNetCoreInstrumentation()
        .AddOtlpExporter(opts =>
            opts.Endpoint = new Uri(
                builder.Configuration["OpenTelemetry:OtlpEndpoint"] ?? "http://localhost:4317")));

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
