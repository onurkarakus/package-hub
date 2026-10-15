open Newtonsoft.Json.Linq

let json = JObject.Parse("{\"ok\":true}")
printfn "%s" (json.ToString())
