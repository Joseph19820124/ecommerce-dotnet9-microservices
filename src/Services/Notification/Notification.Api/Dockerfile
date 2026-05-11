FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

COPY src/SharedKernel/ECommerce.SharedKernel/ECommerce.SharedKernel.csproj SharedKernel/ECommerce.SharedKernel/
COPY src/Services/Notification/Notification.Api/Notification.Api.csproj Services/Notification/Notification.Api/

RUN dotnet restore Services/Notification/Notification.Api/Notification.Api.csproj

COPY src/SharedKernel/ SharedKernel/
COPY src/Services/Notification/ Services/Notification/

RUN dotnet publish Services/Notification/Notification.Api/Notification.Api.csproj \
    -c Release -o /app/publish --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:9.0
WORKDIR /app
EXPOSE 8080
ENV ASPNETCORE_URLS=http://+:8080
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "Notification.Api.dll"]
