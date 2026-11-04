using Contoso.Shop.Core;
using Dapper;
using Microsoft.Data.SqlClient;

namespace Contoso.Shop.Data;

public sealed class OrderRepository(string connectionString)
{
    public async Task<Order?> FindAsync(int id)
    {
        await using var connection = new SqlConnection(connectionString);
        return await connection.QuerySingleOrDefaultAsync<Order>(
            "select Id, Customer, Total from Orders where Id = @id", new { id });
    }
}
