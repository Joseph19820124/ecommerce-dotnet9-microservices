FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

# Copy csproj files for layer caching
COPY src/SharedKernel/ECommerce.SharedKernel/ECommerce.SharedKernel.csproj SharedKernel/ECommerce.SharedKernel/
COPY src/Services/Catalog/Catalog.Domain/Catalog.Domain.csproj Services/Catalog/Catalog.Domain/
COPY src/Services/Catalog/Catalog.Infrastructure/Catalog.Infrastructure.csproj Services/Catalog/Catalog.Infrastructure/
COPY src/Services/Catalog/Catalog.Api/Catalog.Api.csproj Services/Catalog/Catalog.Api/

RUN dotnet restore Services/Catalog/Catalog.Api/Catalog.Api.csproj

COPY src/SharedKernel/ SharedKernel/
COPY src/Services/Catalog/ Services/Catalog/

RUN dotnet publish Services/Catalog/Catalog.Api/Catalog.Api.csproj \
    -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:9.0
WORKDIR /app
EXPOSE 8080
ENV ASPNETCORE_URLS=http://+:8080
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "Catalog.Api.dll"]
