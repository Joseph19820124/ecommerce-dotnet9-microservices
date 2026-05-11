FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

COPY src/SharedKernel/ECommerce.SharedKernel/ECommerce.SharedKernel.csproj SharedKernel/ECommerce.SharedKernel/
COPY src/Services/Order/Order.Domain/Order.Domain.csproj Services/Order/Order.Domain/
COPY src/Services/Order/Order.Application/Order.Application.csproj Services/Order/Order.Application/
COPY src/Services/Order/Order.Infrastructure/Order.Infrastructure.csproj Services/Order/Order.Infrastructure/
COPY src/Services/Order/Order.Api/Order.Api.csproj Services/Order/Order.Api/

RUN dotnet restore Services/Order/Order.Api/Order.Api.csproj

COPY src/SharedKernel/ SharedKernel/
COPY src/Services/Order/ Services/Order/

RUN dotnet publish Services/Order/Order.Api/Order.Api.csproj \
    -c Release -o /app/publish --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:9.0
WORKDIR /app
EXPOSE 8080
ENV ASPNETCORE_URLS=http://+:8080
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "Order.Api.dll"]
