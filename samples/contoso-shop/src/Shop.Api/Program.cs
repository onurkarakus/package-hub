using Contoso.Shop.Core;
using Serilog;

var builder = WebApplication.CreateBuilder(args);
builder.Host.UseSerilog((context, logger) => logger.WriteTo.Console());
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();
builder.Services.AddSingleton<OrderValidator>();

var app = builder.Build();
app.UseSwagger();
app.UseSwaggerUI();

app.MapGet("/orders/{id:int}", (int id) => Results.Ok(new Order(id, "Contoso", 42.50m)));

app.Run();
