using FluentValidation;

namespace Contoso.Shop.Core;

public sealed record Order(int Id, string Customer, decimal Total);

public sealed class OrderValidator : AbstractValidator<Order>
{
    public OrderValidator()
    {
        RuleFor(order => order.Customer).NotEmpty();
        RuleFor(order => order.Total).GreaterThan(0);
    }
}
