using ECommerce.Catalog.Domain.Repositories;
using ECommerce.Catalog.Infrastructure.Persistence;
using ECommerce.Catalog.Infrastructure.Repositories;
using ECommerce.SharedKernel.Abstractions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using OpenSearch.Client;
using StackExchange.Redis;

namespace ECommerce.Catalog.Infrastructure;

public static class InfrastructureExtensions
{
    public static IServiceCollection AddCatalogInfrastructure(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        // PostgreSQL via RDS — connection string from Secrets Manager (injected as env var)
        services.AddDbContext<CatalogDbContext>(opts =>
            opts.UseNpgsql(configuration.GetConnectionString("CatalogDb"),
                npgsql => npgsql.MigrationsHistoryTable("__ef_migrations", "catalog")));

        services.AddScoped<IUnitOfWork>(sp => sp.GetRequiredService<CatalogDbContext>());
        services.AddScoped<IProductRepository, ProductRepository>();

        // ElastiCache Serverless Redis — TLS required on AWS
        services.AddSingleton<IConnectionMultiplexer>(_ =>
        {
            var connStr = configuration.GetConnectionString("Redis")!;
            var options = ConfigurationOptions.Parse(connStr);
            options.Ssl = true;
            options.AbortOnConnectFail = false;
            return ConnectionMultiplexer.Connect(options);
        });

        // Amazon OpenSearch Service (replaces Elasticsearch)
        // OpenSearch.Client is API-compatible with NEST for standard operations
        services.AddSingleton<IOpenSearchClient>(_ =>
        {
            var endpoint = configuration["OpenSearch:Endpoint"]!;
            var settings = new ConnectionSettings(new Uri(endpoint))
                .DefaultIndex("catalog-products")
                .EnableHttpCompression()
                .ServerCertificateValidationCallback((o, cert, chain, errors) => true);
            return new OpenSearchClient(settings);
        });

        return services;
    }
}
