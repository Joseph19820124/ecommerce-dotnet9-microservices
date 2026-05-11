FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

COPY src/SharedKernel/ECommerce.SharedKernel/ECommerce.SharedKernel.csproj SharedKernel/ECommerce.SharedKernel/
COPY src/Services/Inventory/Inventory.Domain/Inventory.Domain.csproj Services/Inventory/Inventory.Domain/
COPY src/Services/Inventory/Inventory.Infrastructure/Inventory.Infrastructure.csproj Services/Inventory/Inventory.Infrastructure/
COPY src/Services/Inventory/Inventory.Api/Inventory.Api.csproj Services/Inventory/Inventory.Api/

RUN dotnet restore Services/Inventory/Inventory.Api/Inventory.Api.csproj

COPY src/SharedKernel/ SharedKernel/
COPY src/Services/Inventory/ Services/Inventory/

RUN dotnet publish Services/Inventory/Inventory.Api/Inventory.Api.csproj \
    -c Release -o /app/publish --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:9.0
WORKDIR /app
EXPOSE 8080
ENV ASPNETCORE_URLS=http://+:8080
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "Inventory.Api.dll"]
