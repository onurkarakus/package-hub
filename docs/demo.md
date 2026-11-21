# Demo

Kayıtlı GIF yoktur. Aşağıdaki adımlar Extension Host penceresindedir.

1. **Run Extension (audit sample)** çalıştır.
2. Scan bitince Package Health ağacını aç.
3. Vulnerable satırında Newtonsoft.Json açıklaması `CPM 12.0.1 · High · AuditQuickFix` olur. `transitive` yazmaz.
4. Satıra tıkla. `AuditQuickFix.csproj` içinde PackageReference satırı açılır.
5. Projects altında AuditQuickFix `1 vulnerable` yazar. Consumer `No packages` yazar.
6. `AuditQuickFix.csproj` içinde Newtonsoft.Json satırının ampulünü aç.
   - Birinci madde: `PackageHub: Update to highest patch 12.0.3, advisory stays open`
   - İkinci madde: `PackageHub: Update to latest 13.0.4, advisory closes`
   - Üçüncü madde: `PackageHub: Update to first fixed version 13.0.1, advisory closes`
7. Üçüncüye tıklama. İptal, pini 12.0.1’de bırakır.
8. `Consumer/Consumer.csproj` içindeki ProjectReference satırında uyarı `is transitive via AuditQuickFix` der.
9. Dashboard’u aç. Proje görünümünde AuditQuickFix altında `direct`, Consumer altında `transitive via AuditQuickFix` durur. Bu görünümde Projects kolonu yoktur.
10. Paket adına tıkla. Yol penceresi Consumer → AuditQuickFix → Newtonsoft.Json yolunu yazar.

Güncellemeyi onaylama.

## 0.3 adımları

11. Package Health görünümünde **+** düğmesine bas. `Newtonsoft` yaz. Yerel önbellekteki sürümler hemen listelenir.
12. Paketi seç, AuditQuickFix projesini işaretle, bir sürüm seç. Onay penceresinde `What's in …` satırları lisansı, sürüm notlarını ve bağımlılıkları yazar. **Yes, Add** deme.
13. Dashboard’da **Add package** sekmesini aç. `Serilog` yaz, **Search package sources** düğmesine bas. Sonuçlar `dotnet package search` ile gelir.
14. Satırdaki işaretin üstüne gel. İpucunda **Update to …**, **Open Advisory** ve **Why is this here?** bağlantıları vardır.
15. Türkçe dil paketini kur ve VS Code dilini Türkçe yap (`Configure Display Language`). Komutlar, ayarlar ve dashboard Türkçe görünür.
