using ECommerce.Catalog.Domain.Repositories;
using ECommerce.Catalog.Infrastructure.Persistence;
using ECommerce.Catalog.Infrastructure.Repositories;
using ECommerce.SharedKernel.Abstractions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Nest;
using StackExchange.Redis;

namespace ECommerce.Catalog.Infrastructure;

public static class InfrastructureExtensions
{
    public static IServiceCollection AddCatalogInfrastructure(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        services.AddDbContext<CatalogDbContext>(opts =>
            opts.UseNpgsql(configuration.GetConnectionString("CatalogDb"),
                npgsql => npgsql.MigrationsHistoryTable("__ef_migrations", "catalog")));

        services.AddScoped<IUnitOfWork>(sp => sp.GetRequiredService<CatalogDbContext>());
        services.AddScoped<IProductRepository, ProductRepository>();

        // Redis
        services.AddSingleton<IConnectionMultiplexer>(_ =>
            ConnectionMultiplexer.Connect(configuration.GetConnectionString("Redis")!));

        // Elasticsearch
        services.AddSingleton<IElasticClient>(_ =>
        {
            var settings = new ConnectionSettings(
                new Uri(configuration["Elasticsearch:Uri"]!))
                .DefaultIndex("catalog-products");
            return new ElasticClient(settings);
        });

        return services;
    }
}
