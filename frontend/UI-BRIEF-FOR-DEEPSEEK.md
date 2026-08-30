# NetConsole — frontend UI brief (for design consult)

Copy toàn bộ file này cho DeepSeek. Đây là snapshot giao diện hiện tại (sau khi rollback rewrite shadcn trên các tab bảng).

## 1. App là gì

NetConsole = dashboard quản trị lab mạng (Juniper EX/QFX sim + Kea DHCP HA).
Người dùng: Network Team. Ngôn ngữ UI: tiếng Việt + English lẫn.

Tab: Dashboard, Devices, Discovery, MAC Address, ARP, Interfaces, Generate Config, DHCP, Jobs, Settings, Device Detail.

Mục tiêu tư vấn: làm UI **đồng nhất, hiện đại, full-width, mật độ thông tin tốt** (kiểu Linear / shadcn dashboard), **không phá logic API**. Tránh code spaghetti (đã thử rewrite toàn bộ tab sang shadcn rồi rollback vì code xấu).

## 2. Stack hiện tại

- React 19 + Vite 6 + TypeScript, alias `@/` → `src/`
- **Hai hệ UI song song:**
  - Shell + Dashboard + Settings: shadcn-style + Tailwind CSS 4 (`@tailwindcss/vite`)
  - Các tab bảng: **Ant Design 5** (`antd` + `@ant-design/icons`)
- Font: Inter Variable, JetBrains Mono
- Icon shell: lucide-react
- Theme: class `.dark` trên `<html>`, localStorage `nc-theme`
- **Không bật Tailwind preflight** (chỉ import `theme.css` + `utilities.css`) để AntD table/input còn sống
- Tailwind v4 `@layer base` thua CSS unlayered của `antd/dist/reset.css` → link/border hay bị lệch

`package.json` UI deps chính: `antd`, `@ant-design/icons`, `tailwindcss`, `@tailwindcss/vite`, `@radix-ui/react-*` (avatar, dialog, dropdown, progress, separator, slot, tooltip), `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`.

Entry `src/main.tsx` import thứ tự:
1. Inter / JetBrains font
2. `src/styles/index.css` (tokens + Tailwind)
3. `antd/dist/reset.css`
4. `src/styles/antd-bridge.css`
5. ThemeProvider → BrowserRouter → App

`src/styles/app.css` **không còn được import** (CSS AntD đời cũ, còn file).

## 3. Routes

```
/                      DashboardPage          (shadcn)
/devices               DevicesPage            (AntD)
/devices/:id           DeviceDetailPage       (AntD Tabs)
/discovery             DiscoveryPage          (AntD)
/mac-addresses         MacAddressPage         (AntD)
/arp-addresses         ArpPage                (AntD)
/interfaces            InterfacesPage         (AntD)
/generate-config       GenerateConfigPage     (AntD)
/dhcp                  DhcpPage               (AntD)
/jobs                  JobsPage               (AntD)
/settings              SettingsPage           (shadcn)
```

## 4. Design tokens — `src/styles/index.css`

Tailwind 4 `@theme inline` map sang CSS variables.

Light:
```
--radius: 0.5rem
--background: oklch(0.97 0.005 247)     // xám xanh nhạt
--foreground: oklch(0.21 0.03 260)
--card: white
--primary: oklch(0.52 0.19 258)         // blue
--muted-foreground: oklch(0.52 0.02 260)
--border: oklch(0.91 0.01 247)
--sidebar: oklch(0.2 0.03 260)          // gần đen
--sidebar-foreground: oklch(0.86 0.015 247)
--sidebar-primary: oklch(0.7 0.14 230)
```

Dark: background oklch(0.18…), card 0.22, primary sáng hơn.

Body: 14px, Inter, letter-spacing -0.011em, antialiased.
`a { color: inherit; text-decoration: none }` trong `@layer base` (dễ bị AntD reset đè).

## 5. Shell — `src/layouts/AppLayout.tsx`

Layout admin chuẩn:
- `h-screen` flex: sidebar trái + cột phải (header 56px + main scroll)
- Sidebar: `w-56` / collapsed `w-72px`, bg `bg-sidebar`, item active `bg-white/10`
- Header: title + subtitle, search giả (mở Command palette ⌘K), theme toggle sun/moon, avatar “Network Team / Administrator”
- Main: `p-4` + `AntdBridge` bọc `<Outlet />`

Nav items + subtitle:
- Dashboard — Tổng quan lab
- Devices — Site, tầng, IP, ping và managed check
- Discovery — Ping · SSH · sync inventory
- MAC Address — ethernet-switching table
- ARP — show arp
- Interfaces — shut / no shut / access VLAN
- Generate Config — mẫu Core/Dist/Access · commit
- DHCP — Kea HA · pool · lease
- Jobs — PENDING → RUNNING → SUCCESS/FAILED
- Settings — kiến trúc và giao diện

## 6. Ant Design theme bridge — `src/components/antd-bridge.tsx`

```ts
colorPrimary: dark ? '#5eb0ef' : '#2563eb'
colorInfo: '#0ea5e9'
colorSuccess: '#16a34a'
colorWarning: '#d97706'
colorError: '#ef4444'
borderRadius: 8
fontSize: 14
fontFamily: Inter Variable
colorBgContainer: dark ? '#1c2434' : '#ffffff'
colorBgLayout: dark ? '#1a2232' : '#f4f7fb'
colorBorder: dark ? 'rgba(255,255,255,0.1)' : '#e2e8f0'
Table.headerBg: dark ? '#243044' : '#f8fafc'
Button.controlHeight: 34
variant: "outlined"
```

`antd-bridge.css` vá:
- `.nc-page-shell` flex column gap 12px
- `.nc-stat-row` grid 4 cột
- ép AntD Input/Select `border: 1px solid` (Tailwind từng làm input chỉ còn gạch chân dưới)
- `.nc-code-block` / `.nc-config-editor` nền `#0f172a`
- icon button interface 40×40

## 7. shadcn primitives đang có

`src/components/ui/`: button, card, badge, input, table, progress, avatar, separator, tooltip, dialog, dropdown-menu.

Button CVA: default / secondary / outline / ghost / destructive / sidebar; sizes default/sm/lg/icon.

Card: `rounded-xl border border-border/80`, header `px-5 py-4`, title 13px medium.

Table: `text-[13px]`, th uppercase 11px muted, td `h-12 px-5`.

**Không có** Select/Tabs/Toast/Form shadcn (đã xóa khi rollback).

## 8. Dashboard (shadcn) — layout ý

- `max-w-[1280px] mx-auto gap-8` (căn giữa, không full-width)
- 4 metric cards: Devices / Jobs / DHCP / Addresses — số ~32px
- Grid `1.55fr / 0.85fr`: bảng Devices + Fabric counts + System health (dot + text)
- Dưới: DHCP pools (Progress) + Recent jobs
- Status: chấm màu + chữ, không badge la hét SUCCESS
- Device name: Link không underline, IP mono 12px

## 9. Các tab AntD (pattern chung)

Wrapper `.nc-page-shell`.
Thường có: Alert giải thích → Row Statistic cards → Card filter/toolbar → Table `scroll.x` lớn → Modal Form.

- **Devices:** stats tổng/managed/online/offline/bảo trì; filter search+site+status; ping all; managed check (ping→SSH→show version→show run); CRUD Modal
- **Discovery:** form CIDR + site/floor; Progress scan; Table checkbox sync inventory
- **MAC / ARP:** auto refresh 10s; filter All site/tầng/thiết bị; collect job
- **Interfaces:** chọn site→device rồi mới list port; shut / no-shut / VLAN access / show run
- **Generate Config:** running config vs draft template Core/Dist/Access; commit/rollback chỉ khi MANAGED
- **DHCP:** Kea HA peers, pool cards + lease table, fix static / wipe
- **Jobs:** queue table
- **Device Detail:** Tabs Thông tin / Config / ARP / MAC / Kết nối

## 10. Vấn đề UX đã gặp (cần tư vấn)

1. **Hai design system** (shadcn shell vs AntD tables) → nhìn ghép, link xanh gạch chân, input bị underline, theme dark lệch.
2. **Dashboard max-w 1280** → màn rộng hai bên trống; full-width thì card/cột bảng bị kéo phình, actions trôi mép phải.
3. Rewrite toàn bộ tab sang shadcn một lần → UI ổn hơn một chút nhưng **code xấu**, đã rollback.
4. Muốn look **Linear / shadcn**: nhiều không khí vừa phải, không rainbow Tag, không bảng HTML đời 2005, vẫn full màn hình và dense.
5. Constraint: Vite (không Next.js), giữ API/job/worker, frontend chạy Docker `netconsole-frontend` **không volume** (sửa file phải `docker cp` hoặc `compose up --no-deps frontend`).

## 11. Câu hỏi muốn DeepSeek trả lời

1. Nên **giữ AntD cho table** và chỉ theme cho khớp shell, hay **migrate dần từng tab** sang shadcn (kế hoạch file-by-file, primitive nào cần)?
2. Pattern full-width: stat bar 1 hàng + table cột `whitespace-nowrap` dump extra space vào cột đầu — có phải cách đúng?
3. Token/spacing scale cụ thể (sidebar width, row height, metric) để không vừa trống vừa chật.
4. Chiến lược CSS: bật preflight hay không; làm sao hết xung đột AntD reset vs Tailwind v4 layers.
5. Đề xuất IA/visual cho Devices (trang bị chê nhiều nhất) — wireframe/class, không cần rewrite cả repo.

Không cần generate toàn bộ source 12 trang. Ưu tiên hệ thống thiết kế + 1 trang Devices mẫu + thứ tự migrate.
