using ECommerce.Catalog.Domain.Entities;
using ECommerce.Catalog.Domain.ValueObjects;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace ECommerce.Catalog.Infrastructure.Persistence.Configurations;

public sealed class ProductConfiguration : IEntityTypeConfiguration<Product>
{
    public void Configure(EntityTypeBuilder<Product> builder)
    {
        builder.ToTable("products");

        builder.HasKey(p => p.Id);

        builder.Property(p => p.Id)
            .HasConversion(
                id => id.Value,
                value => ProductId.Create(value))
            .HasColumnName("id");

        builder.Property(p => p.Name)
            .HasMaxLength(200)
            .IsRequired()
            .HasColumnName("name");

        builder.Property(p => p.Description)
            .HasMaxLength(2000)
            .HasColumnName("description");

        builder.OwnsOne(p => p.Price, price =>
        {
            price.Property(m => m.Amount)
                .HasColumnName("price_amount")
                .HasColumnType("numeric(18,4)")
                .IsRequired();

            price.Property(m => m.Currency)
                .HasMaxLength(3)
                .HasColumnName("price_currency")
                .IsRequired();
        });

        builder.Property(p => p.CategoryId)
            .HasColumnName("category_id")
            .IsRequired();

        builder.Property(p => p.Sku)
            .HasMaxLength(50)
            .IsRequired()
            .HasColumnName("sku");

        builder.HasIndex(p => p.Sku).IsUnique();

        builder.Property(p => p.IsActive)
            .HasDefaultValue(true)
            .HasColumnName("is_active");

        builder.Property(p => p.CreatedAt)
            .HasColumnName("created_at")
            .IsRequired();

        builder.Property(p => p.UpdatedAt)
            .HasColumnName("updated_at");

        builder.Ignore(p => p.DomainEvents);
    }
}
