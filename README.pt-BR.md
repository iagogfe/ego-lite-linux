# ego-lite-linux

[English](README.md) · **Português**

Host não-oficial de Linux/WSL para o [ego lite](https://github.com/citrolabs/ego-lite), o navegador em que você e seus agentes de IA trabalham em paralelo.

O ego lite é distribuído como app de macOS. Este repositório mantém a skill e o harness `ego-browser` do upstream intactos e acrescenta o `package/ego-linux-host`: um supervisor de Chromium de vida longa mais um shim de CLI, para que agentes rodem os mesmos heredocs `ego-browser` contra um navegador compartilhado no Chromium padrão.

> Sem vínculo com a CitroLabs. Este é um port de comunidade que aproxima o modelo do produto ego no Linux — **não** é o app ego lite, nem o substitui no macOS.

## O que você ganha

| | |
|---|---|
| **Mesma interface de agente** | O agente continua escrevendo heredocs JavaScript do `ego-browser` — snapshot, click, fill, wait, navigate, capture. Nenhuma API nova. |
| **Um navegador compartilhado** | Um daemon supervisiona um único Chromium com o seu perfil, então os logins vêm junto em vez de ficarem num perfil descartável de automação. |
| **Task Spaces no Chromium padrão** | Spaces são modelados como conjuntos de abas com dono, então as abas do agente ficam separadas das suas e você pode assumir um Space no meio da tarefa. |
| **Só CDP** | Sem patch de kernel, sem build de navegador forkado. O Chrome ou Chromium da sua distro basta. |

## Requisitos

- Linux, ou WSL com Chrome/Chromium do lado Linux
- Node.js ≥ 22
- Chrome/Chromium para navegador de verdade (os testes unitários rodam sem ele)

## Instalação

```bash
git clone https://github.com/iagogfe/ego-lite-linux.git
cd ego-lite-linux
bash skills/ego-browser/scripts/install-linux.sh
export PATH="$HOME/.local/bin:$PATH"
ego-browser --doctor
```

O instalador compila o harness e o host, cria o symlink do `ego-browser` em `~/.local/bin`, cria os diretórios de dados, detecta o Chrome e roda o diagnóstico.

**Não** rode `skills/ego-browser/scripts/install.sh` aqui — esse é o caminho de macOS do upstream e espera o DMG do ego lite.

Modo headed precisa de display (WSLg ou `DISPLAY` nativo); sem ele, use `EGO_HEADLESS=1`. Para navegador em caminho fora do padrão, defina `EGO_CHROME_PATH=/caminho/do/chrome`.

Instruções completas e troubleshooting: [`skills/ego-browser/references/install.md`](skills/ego-browser/references/install.md) (seção **Install steps (Linux / WSL)**).

## Uso

Descreva a tarefa em linguagem natural pro seu CLI de agente, igual ao upstream:

```
ego-browser abre example.com e me diz o título da página
```

O agente carrega a skill `ego-browser`, abre a página no Space dele, lê um Snapshot, age na página e reporta de volta — enquanto suas abas ficam intocadas.

## Status

MVP. Daemon, ponte CDP, Task Spaces, shim de CLI, diagnóstico `--doctor`, recuperação de socket órfão e respawn do Chrome funcionam, e o checklist manual de aceitação passa no Chrome headed em Linux. Trate como software novo: a superfície é menor que a do app de macOS, e o caminho de seed de perfil vem desligado por padrão porque pode corromper um perfil de Chrome em uso.

Detalhes e internals: [`package/ego-linux-host/README.md`](package/ego-linux-host/README.md).
Spec de design: [`docs/superpowers/specs/2026-07-23-ego-linux-host-design.md`](docs/superpowers/specs/2026-07-23-ego-linux-host-design.md).

## Diferenças em relação ao upstream

| | upstream `citrolabs/ego-lite` | este repo |
|---|---|---|
| Plataforma | app de macOS (`.dmg`) | Linux / WSL |
| Navegador | ego lite, build customizado do Chromium | Chrome/Chromium padrão via CDP |
| Qualidade do Snapshot | customização em nível de kernel | árvore de acessibilidade via CDP |
| Distribuição | download + `npx skills add citrolabs/ego-lite` | clone + `install-linux.sh` |

Tudo em `package/ego-browser` e `skills/ego-browser` acompanha o upstream. O trabalho específico de Linux está em `package/ego-linux-host` e `skills/ego-browser/scripts/install-linux.sh`.

## Desenvolvimento

```bash
cd package/ego-linux-host
npm ci
npm test        # build + typecheck + node --test, sem Chrome
./scripts/smoke.sh   # ponta a ponta, precisa de Chrome + display (ou EGO_HEADLESS=1)
```

O CI roda as suítes de `package/ego-browser` e `package/ego-linux-host` em todo push e pull request. Veja o [CONTRIBUTING.md](CONTRIBUTING.md).

## Créditos

Construído sobre o [ego lite](https://github.com/citrolabs/ego-lite) da [CitroLabs](https://github.com/citrolabs) — o harness `ego-browser`, a skill de agente e o modelo de Spaces são deles. Para o app de macOS, a documentação e a comunidade, vá ao projeto original:

- [lite.ego.app/document/](https://lite.ego.app/document/) — documentação
- [Discord](https://discord.gg/5eGZVvHbTq) · [GitHub Discussions](https://github.com/citrolabs/ego-lite/discussions)

## Segurança

Veja o [SECURITY.md](SECURITY.md).

## Licença

[MIT](LICENSE), a mesma do upstream.
