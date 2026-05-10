using ECommerce.Catalog.Domain.Entities;
using ECommerce.SharedKernel.Domain;
using MediatR;
using Microsoft.EntityFrameworkCore;

namespace ECommerce.Catalog.Infrastructure.Persistence;

public sealed class CatalogDbContext(
    DbContextOptions<CatalogDbContext> options,
    IPublisher publisher) : DbContext(options)
{
    public DbSet<Product> Products => Set<Product>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(CatalogDbContext).Assembly);
        base.OnModelCreating(modelBuilder);
    }

    public override async Task<int> SaveChangesAsync(CancellationToken ct = default)
    {
        var domainEvents = ChangeTracker.Entries<AggregateRoot<dynamic>>()
            .SelectMany(e => e.Entity.DomainEvents)
            .ToList();

        var result = await base.SaveChangesAsync(ct);

        foreach (var domainEvent in domainEvents)
            await publisher.Publish(domainEvent, ct);

        return result;
    }
}
