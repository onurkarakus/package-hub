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
