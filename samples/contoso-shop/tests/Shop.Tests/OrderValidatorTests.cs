using Contoso.Shop.Core;
using Xunit;

namespace Contoso.Shop.Tests;

public class OrderValidatorTests
{
    [Fact]
    public void An_order_without_a_customer_is_invalid()
    {
        var result = new OrderValidator().Validate(new Order(1, "", 10m));
        Assert.False(result.IsValid);
    }
}
