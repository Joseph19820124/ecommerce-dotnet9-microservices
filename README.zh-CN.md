# ECommerce — 企业级 .NET 9 微服务平台

基于 .NET 9 构建的生产就绪电商平台，采用垂直切片架构、DDD 和 CQRS。

[English](./README.md) | [架构文档](./docs/architecture.md)

## 快速启动

```bash
cp .env.example .env
docker compose up -d
```

启动后可访问的服务：

| 服务 | 地址 |
|------|------|
| API 网关 | http://localhost:5000 |
| 商品服务（Swagger） | http://localhost:8081/openapi |
| 订单服务（Swagger） | http://localhost:8083/openapi |
| 身份认证服务 | http://localhost:8082 |
| RabbitMQ 管理界面 | http://localhost:15672 (guest/guest) |
| Kibana 日志 | http://localhost:5601 |
| PgAdmin 数据库管理 | http://localhost:5050 |
| Zipkin 链路追踪 | http://localhost:9411 |

## 技术栈

| 层次 | 技术选型 |
|------|---------|
| 运行时 | .NET 9, C# 13 |
| 架构模式 | 垂直切片、DDD、CQRS |
| 结果模式 | ErrorOr 2.x |
| 消息总线 | MediatR 12, MassTransit 8, RabbitMQ |
| 验证 | FluentValidation 11 |
| 身份认证 | Duende IdentityServer 7 |
| 数据库 | PostgreSQL 16, EF Core 9（Code First） |
| 搜索 | Elasticsearch 8, NEST |
| 缓存 | Redis 7 |
| API 网关 | YARP 2.3 |
| 可观测性 | Serilog, OpenTelemetry, Zipkin, Kibana |
| 前端 | Blazor Web App（Server+WASM）, Next.js 13+ |
| 国际化 | zh-CN / en-US 双语支持 |

## 解决方案结构

```
src/
├── SharedKernel/
│   └── ECommerce.SharedKernel/        # 公共抽象、基类、Pipeline Behaviors
├── Services/
│   ├── Catalog/                        # 商品目录 + Elasticsearch 全文搜索
│   ├── Identity/                       # Duende IdentityServer + 用户管理
│   ├── Inventory/                      # 库存管理（gRPC 服务端）
│   ├── Order/                          # 订单 + MassTransit Saga 编排
│   ├── Payment/                        # 支付集成桩 + 回调处理
│   └── Notification/                   # 邮件/短信消费者
├── ApiGateway/
│   └── ECommerce.ApiGateway/           # YARP 反向代理
└── Frontend/
    ├── ECommerce.Web.Blazor/           # Blazor SSR + WASM 混合模式
    └── ecommerce-nextjs/               # Next.js 13+ App Router
tests/
docs/
docker-compose.yml
```

## 垂直切片示例（创建商品）

```
Features/Products/CreateProduct.cs
├── CreateProductCommand    # 命令定义（ICommand<CreateProductResponse>）
├── CreateProductValidator  # 校验器（FluentValidation，支持 i18n）
├── CreateProductHandler    # 处理器（返回 ErrorOr<T>）
└── CreateProductEndpoint   # 端点（Carter → POST /api/v1/products）
```

## 订单 Saga 状态机

```
订单创建 → 预扣库存 → 处理支付 → 订单确认
              ↓ 失败          ↓ 失败
           取消订单    释放库存（补偿操作）→ 取消订单
```

每个状态转换通过 RabbitMQ 消息驱动，使用 Outbox Pattern 保证至少一次投递。

## 国际化

后端通过 `Accept-Language` 请求头自动切换语言，所有错误消息和验证提示均支持中英文。

```bash
# 指定中文
curl -H "Accept-Language: zh-CN" https://localhost:5000/api/catalog/products
```

## 运行数据库迁移

```bash
# 商品服务
dotnet ef migrations add Init \
  -p src/Services/Catalog/Catalog.Infrastructure \
  -s src/Services/Catalog/Catalog.Api

# 订单服务
dotnet ef migrations add Init \
  -p src/Services/Order/Order.Infrastructure \
  -s src/Services/Order/Order.Api
```
