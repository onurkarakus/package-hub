# PackageHub

.NET projelerindeki sarı NU190x uyarısını açıklar. Varsayılan düzeltme, aynı major içindeki en yüksek yamadır. Latest ancak daha yeni ise ikinci seçenektir.

Paket galerisi değildir. Üç boyutlu bağımlılık çizmez. Kullanım verisi göndermez.

## Gerekenler

- VS Code 1.125 veya daha yenisi
- PATH içinde `dotnet`
- `PackageHub: Why is this here?` için .NET SDK 8.0.400 veya daha yenisi

## Kurulum

Marketplace paketi yoktur. Kaynaktan açmak için repo kökünde:

```bash
npm install
```

VS Code içinde **Run Extension** çalıştır. Örnek çözüm için **Run Extension (audit sample)** kullan.

## Örnek

`samples/audit-quickfix` Newtonsoft.Json **12.0.1** sabitler. Sürüm `Directory.Packages.props` içindedir. Csproj satırında `Version` yoktur.

| | |
| --- | --- |
| Açık | NU1903, GHSA-5crp-9r3c-p9vr |
| Highest patch | 12.0.3, advisory açık kalır |
| Latest | 13.0.4, advisory kapanır |
| First fixed | 13.0.1 |

AuditQuickFix paketi doğrudan referans eder. Consumer yalnız proje referansı verir, bu yüzden Projects ağacında `No packages` yazar. Açık, Consumer’daki ProjectReference satırında `transitive via AuditQuickFix` olarak durur.

Güncellemeyi onaylama. Pin 12.0.1 kalır.

## Özellikler

- Tarama `dotnet list package` kullanır. Açık taraması transitive paketleri de alır. Outdated ve deprecated listesi doğrudan paketlerdir.
- Ampulün birinci maddesi highest patch’tir. Latest ikinci maddedir. Advisory kaydı varsa pencere sürümün açığı kapatıp kapatmadığını söyler. Kayıt yoksa “kapatır” demez.
- First fixed, kayıttaki dışlayıcı üst sınırdır. Bu örnekte 13.0.1’dir ve tercih edilen tık değildir.
- Hover açıklamadır ve `dotnet` başlatmaz. Satır sağ tıkı: highest patch, latest, Open Advisory, Why, Ignore, Remove.
- CodeLens yalnız sorunlu satırdadır. Tıklama highest patch’tir.
- Activity Bar’daki Package Health ağacı sayıları bölüm satırında gösterir. Doğrudan paketin satırı projeyi yazar ve `transitive via` yazmaz. Pakete tıklamak `PackageReference` satırını açar.
- Dashboard üç görünüm tutar: liste, proje, paket. Proje görünümünde Projects kolonu yoktur. Toplu düğmeler Highest patch ve Highest minor’dır. Major bu düğmelere girmez.
- Paket adına tıklamak tek bir yol penceresi açar. Kenarlar `obj/project.assets.json` dosyasındandır. Dosya yoksa kenar uydurulmaz.
- İki ücretsiz pano raporu vardır: sağlık raporu ve açık raporu. Dosyaya veya SARIF’e yazılmaz.
- CPM sürümü `Directory.Packages.props` içinden okunur. Yazma `dotnet add package` ile olur.
- Çalışma alanındaki `NuGet.config` yalnız kaynak adlarını dashboard’a yazar. Adres ve parola okunmaz.

## Ayarlar

| Ayar | Varsayılan | Anlamı |
| --- | --- | --- |
| `packageHub.scanOnStartup` | açık | Klasör açılınca tarar |
| `packageHub.includePrerelease` | kapalı | Yalnız sonraki outdated listesine ön sürüm katar |
| `packageHub.minimumSeverity` | low | Rapor eşiği. Projedeki `NuGetAuditLevel` değişmez |
| `packageHub.minimumReleaseAge` | 0 | Latest için gün eşiği. 0 kapalıdır. Patch bu eşiğe girmez |
| `packageHub.dashboardViewMode` | list | Dashboard görünümü |
| `packageHub.ignoredPackages` | boş | PackageHub listesinden gizlenen paketler |

`packageHub.telemetry` yoktur.

## Demo

Adımlar [docs/demo.md](docs/demo.md) içindedir. Kayıtlı bir GIF yoktur. Ekran, Extension Host penceresinden izlenir.

## Geliştirme

```bash
npm test
```

Bu komut birim testleri ve `samples/audit-quickfix` üzerindeki Extension Host testini çalıştırır. Test koşusu paketi güncellemez.
