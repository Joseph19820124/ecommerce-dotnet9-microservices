FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

COPY src/SharedKernel/ECommerce.SharedKernel/ECommerce.SharedKernel.csproj SharedKernel/ECommerce.SharedKernel/
COPY src/Services/Payment/Payment.Domain/Payment.Domain.csproj Services/Payment/Payment.Domain/
COPY src/Services/Payment/Payment.Infrastructure/Payment.Infrastructure.csproj Services/Payment/Payment.Infrastructure/
COPY src/Services/Payment/Payment.Api/Payment.Api.csproj Services/Payment/Payment.Api/

RUN dotnet restore Services/Payment/Payment.Api/Payment.Api.csproj

COPY src/SharedKernel/ SharedKernel/
COPY src/Services/Payment/ Services/Payment/

RUN dotnet publish Services/Payment/Payment.Api/Payment.Api.csproj \
    -c Release -o /app/publish --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:9.0
WORKDIR /app
EXPOSE 8080
ENV ASPNETCORE_URLS=http://+:8080
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "Payment.Api.dll"]
