FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

COPY src/ApiGateway/ECommerce.ApiGateway/ECommerce.ApiGateway.csproj ApiGateway/ECommerce.ApiGateway/

RUN dotnet restore ApiGateway/ECommerce.ApiGateway/ECommerce.ApiGateway.csproj

COPY src/ApiGateway/ ApiGateway/

RUN dotnet publish ApiGateway/ECommerce.ApiGateway/ECommerce.ApiGateway.csproj \
    -c Release -o /app/publish --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:9.0
WORKDIR /app
EXPOSE 8080
ENV ASPNETCORE_URLS=http://+:8080
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "ECommerce.ApiGateway.dll"]
