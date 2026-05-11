using ECommerce.Catalog.Domain.Repositories;
using ECommerce.Catalog.Infrastructure.Persistence;
using ECommerce.Catalog.Infrastructure.Repositories;
using ECommerce.SharedKernel.Abstractions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using OpenSearch.Client;
using StackExchange.Redis;
using System.Text.Json;

namespace ECommerce.Catalog.Infrastructure;

public static class InfrastructureExtensions
{
    public static IServiceCollection AddCatalogInfrastructure(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        var connStr = BuildConnectionString(configuration);

        services.AddDbContext<CatalogDbContext>(opts =>
            opts.UseNpgsql(connStr,
                npgsql => npgsql.MigrationsHistoryTable("__ef_migrations", "catalog")));

        services.AddScoped<IUnitOfWork>(sp => sp.GetRequiredService<CatalogDbContext>());
        services.AddScoped<IProductRepository, ProductRepository>();

        // ElastiCache — TLS on AWS, plain on local
        var redisEndpoint = configuration["REDIS_ENDPOINT"]
            ?? configuration.GetConnectionString("Redis")
            ?? "localhost:6379";
        services.AddSingleton<IConnectionMultiplexer>(_ =>
        {
            var opts = ConfigurationOptions.Parse(redisEndpoint);
            opts.AbortOnConnectFail = false;
            return ConnectionMultiplexer.Connect(opts);
        });

        // Amazon OpenSearch Service
        var osEndpoint = configuration["OPENSEARCH_ENDPOINT"]
            ?? configuration["OpenSearch:Endpoint"]
            ?? "http://localhost:9200";
        if (!osEndpoint.StartsWith("http")) osEndpoint = $"https://{osEndpoint}";
        services.AddSingleton<IOpenSearchClient>(_ =>
        {
            var settings = new ConnectionSettings(new Uri(osEndpoint))
                .DefaultIndex("catalog-products")
                .EnableHttpCompression()
                .ServerCertificateValidationCallback((o, cert, chain, errors) => true);
            return new OpenSearchClient(settings);
        });

        return services;
    }

    private static string BuildConnectionString(IConfiguration configuration)
    {
        // Try explicit connection string first (local dev)
        var explicit_ = configuration.GetConnectionString("CatalogDb");
        if (!string.IsNullOrEmpty(explicit_)) return explicit_;

        // Build from ECS environment variables
        var host = configuration["DB_HOST"] ?? "localhost";
        var port = configuration["DB_PORT"] ?? "5432";
        var db   = configuration["DB_NAME"] ?? "catalog_db";

        // Password injected by ECS from Secrets Manager as JSON
        var secretJson = configuration["DB_SECRET_JSON"];
        string user = "ecommerceadmin", password = "";
        if (!string.IsNullOrEmpty(secretJson))
        {
            var doc = JsonDocument.Parse(secretJson).RootElement;
            if (doc.TryGetProperty("username", out var u)) user = u.GetString() ?? user;
            if (doc.TryGetProperty("password", out var p)) password = p.GetString() ?? "";
        }

        // Use NpgsqlConnectionStringBuilder to safely escape special chars in password
        var builder = new NpgsqlConnectionStringBuilder
        {
            Host = host,
            Port = int.Parse(port),
            Database = db,
            Username = user,
            Password = password,
            SslMode = SslMode.Require,
            TrustServerCertificate = true,
        };
        return builder.ConnectionString;
    }
}
