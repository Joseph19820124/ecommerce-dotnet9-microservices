using Carter;
using ECommerce.Order.Application.Sagas;
using ECommerce.SharedKernel.Extensions;
using MassTransit;
using Serilog;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using System.Reflection;

var builder = WebApplication.CreateBuilder(args);

builder.Host.UseSerilog((ctx, cfg) =>
    cfg.ReadFrom.Configuration(ctx.Configuration));

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
        opts.RequireHttpsMetadata = false;
    });
builder.Services.AddAuthorization();

// MassTransit + Saga + Outbox
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

    cfg.UsingRabbitMq((ctx, rmq) =>
    {
        rmq.Host(builder.Configuration["RabbitMQ:Host"], h =>
        {
            h.Username(builder.Configuration["RabbitMQ:Username"]!);
            h.Password(builder.Configuration["RabbitMQ:Password"]!);
        });

        rmq.UseMessageRetry(r => r.Exponential(5,
            TimeSpan.FromSeconds(1),
            TimeSpan.FromSeconds(60),
            TimeSpan.FromSeconds(5)));

        rmq.ConfigureEndpoints(ctx);
    });
});

builder.Services.AddOpenTelemetry()
    .WithTracing(tracing => tracing
        .SetResourceBuilder(ResourceBuilder.CreateDefault().AddService("order-api"))
        .AddAspNetCoreInstrumentation()
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
