FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

COPY src/SharedKernel/ECommerce.SharedKernel/ECommerce.SharedKernel.csproj SharedKernel/ECommerce.SharedKernel/
COPY src/Services/Identity/Identity.Api/Identity.Api.csproj Services/Identity/Identity.Api/

RUN dotnet restore Services/Identity/Identity.Api/Identity.Api.csproj

COPY src/SharedKernel/ SharedKernel/
COPY src/Services/Identity/ Services/Identity/

RUN dotnet publish Services/Identity/Identity.Api/Identity.Api.csproj \
    -c Release -o /app/publish --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:9.0
WORKDIR /app
EXPOSE 8080
ENV ASPNETCORE_URLS=http://+:8080
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "Identity.Api.dll"]
