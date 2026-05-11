FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

COPY src/Frontend/ECommerce.Web.Blazor/ECommerce.Web.Blazor.csproj Frontend/ECommerce.Web.Blazor/

RUN dotnet restore Frontend/ECommerce.Web.Blazor/ECommerce.Web.Blazor.csproj

COPY src/Frontend/ Frontend/

RUN dotnet publish Frontend/ECommerce.Web.Blazor/ECommerce.Web.Blazor.csproj \
    -c Release -o /app/publish --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:9.0
WORKDIR /app
EXPOSE 8080
ENV ASPNETCORE_URLS=http://+:8080
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "ECommerce.Web.Blazor.dll"]
