#!/bin/bash
# TermuxAgent Installation Script for Android/Termux
# Compatible with Termux v0.118+ (F-Droid / GitHub releases)
# See: https://github.com/termux/termux-app/releases

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
INSTALL_DIR="$HOME/.termux-agent"
BIN_DIR="${PREFIX:-/data/data/com.termux/files/usr}/bin"
REPO_URL="https://github.com/termux-agent/termux-agent"

echo -e "${BLUE}"
echo "╔═══════════════════════════════════════════╗"
echo "║     🤖 TermuxAgent Installer              ║"
echo "║  Token-Optimized AI for Android          ║"
echo "╚═══════════════════════════════════════════╝"
echo -e "${NC}"

# Check if running in Termux
if [ -z "$TERMUX_VERSION" ] && [ -z "$TERMUX_API_VERSION" ]; then
    echo -e "${YELLOW}⚠️  Warning: Not running in Termux environment${NC}"
    echo "This installer is designed for Termux on Android."
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Check dependencies
echo -e "${BLUE}📋 Checking dependencies...${NC}"

check_command() {
    if command -v "$1" &> /dev/null; then
        echo -e "  ✅ $1 found"
        return 0
    else
        echo -e "  ❌ $1 not found"
        return 1
    fi
}

# Check Node.js
if ! check_command node; then
    echo -e "${YELLOW}📦 Installing Node.js...${NC}"
    pkg update -y
    pkg install -y nodejs-lts
fi

NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo -e "${YELLOW}⚠️  Node.js 20+ required. Current: $(node --version)${NC}"
    echo "Updating Node.js..."
    pkg install -y nodejs-lts
fi

echo -e "  ✅ Node.js $(node --version)"

# Check npm
if ! check_command npm; then
    echo -e "${RED}❌ npm not found. Please reinstall Node.js.${NC}"
    exit 1
fi

echo -e "  ✅ npm $(npm --version)"

# termux-api: Android device integration (camera, SMS, notifications, wake lock, etc.)
if ! check_command termux-api; then
    echo -e "${YELLOW}📦 Installing termux-api...${NC}"
    pkg install -y termux-api
    echo -e "  ${YELLOW}⚠️  Also install the Termux:API companion app from F-Droid!${NC}"
else
    echo -e "  ✅ termux-api found"
fi

# termux-services: runit service supervisor for background daemon support
if ! check_command sv; then
    echo -e "${YELLOW}📦 Installing termux-services (runit)...${NC}"
    pkg install -y termux-services
fi
if check_command sv; then
    echo -e "  ✅ termux-services (runit) found"
else
    echo -e "${YELLOW}  ⚠️  termux-services not installed — daemon mode will be limited${NC}"
fi

# Optional: Check for Python (for code execution tool)
if check_command python3; then
    echo -e "  ✅ Python3 found (for code execution)"
else
    echo -e "${YELLOW}  ⚠️  Python3 not found (optional, for code execution tool)${NC}"
    read -p "Install Python3? (Y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
        pkg install -y python
    fi
fi

# Optional: Check for git
if check_command git; then
    echo -e "  ✅ Git found"
else
    echo -e "${YELLOW}  ⚠️  Git not found (optional)${NC}"
fi

# Create directories
echo -e "${BLUE}📁 Creating directories...${NC}"
mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/memory"
mkdir -p "$INSTALL_DIR/logs"

# Install TermuxAgent
echo -e "${BLUE}📦 Installing TermuxAgent...${NC}"

# Check if installing from source or npm
if [ -f "package.json" ] && [ -d "src" ]; then
    # Installing from source
    echo -e "  📂 Installing from source..."
    npm install
    npm run build
    
    # Copy files
    cp -r dist "$INSTALL_DIR/"
    cp termux-agent.mjs "$INSTALL_DIR/"
    cp package.json "$INSTALL_DIR/"
else
    # Install from npm
    echo -e "  📦 Installing from npm..."
    npm install -g termux-agent@latest
fi

# Create symlink in bin directory
echo -e "${BLUE}🔗 Creating symlinks...${NC}"

if [ -f "$INSTALL_DIR/termux-agent.mjs" ]; then
    ln -sf "$INSTALL_DIR/termux-agent.mjs" "$BIN_DIR/termux-agent"
    ln -sf "$INSTALL_DIR/termux-agent.mjs" "$BIN_DIR/tagent"
    chmod +x "$INSTALL_DIR/termux-agent.mjs"
fi

# Create default config if not exists
CONFIG_FILE="$HOME/.termux-agent/config.json"
if [ ! -f "$CONFIG_FILE" ]; then
    echo -e "${BLUE}⚙️  Creating default configuration...${NC}"
    mkdir -p "$HOME/.termux-agent"
    cat > "$CONFIG_FILE" << 'EOF'
{
  "version": "1.0.0",
  "provider": {
    "default": "openai",
    "openai": {
      "name": "openai",
      "apiKey": "",
      "baseUrl": "https://api.openai.com/v1",
      "defaultModel": "gpt-4o-mini"
    }
  },
  "model": {
    "default": "gpt-4o-mini",
    "temperature": 0.7,
    "maxTokens": 4096
  },
  "context": {
    "maxMessages": 50,
    "maxTokens": 8000,
    "enableSummarization": true
  },
  "memory": {
    "enabled": true,
    "path": "~/.termux-agent/memory",
    "maxSize": 104857600
  },
  "tools": {
    "enabled": ["shell", "file", "code"],
    "timeout": 30000
  },
  "ui": {
    "theme": "auto",
    "showTokens": false,
    "compactMode": true
  }
}
EOF
fi

# Offer background service setup
echo -e "${BLUE}🔧 Background service setup...${NC}"
read -p "Install as a persistent background service? (Y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ -f "$SCRIPT_DIR/setup-termux-service.sh" ]; then
        bash "$SCRIPT_DIR/setup-termux-service.sh"
    else
        echo -e "${YELLOW}⚠️  setup-termux-service.sh not found — run it manually later${NC}"
    fi
else
    echo -e "${YELLOW}  Skipped. Run later with: termux-agent daemon setup${NC}"
fi

# Run setup wizard
echo -e "${BLUE}🚀 Running setup wizard...${NC}"
echo -e "${YELLOW}   You can run this anytime with: termux-agent setup${NC}\n"

if command -v termux-agent &> /dev/null; then
    termux-agent setup
else
    echo -e "${YELLOW}⚠️  termux-agent command not found in PATH${NC}"
    echo "Trying direct execution..."
    node "$INSTALL_DIR/termux-agent.mjs" setup
fi

# Installation complete
echo -e "${GREEN}"
echo "╔═══════════════════════════════════════════╗"
echo "║     ✅ Installation Complete!              ║"
echo "╚═══════════════════════════════════════════╝"
echo -e "${NC}"

echo "Quick start:"
echo "  termux-agent chat           - Start interactive chat"
echo "  termux-agent ask            - Ask a single question"
echo "  termux-agent daemon start   - Start background daemon"
echo "  termux-agent daemon status  - Check daemon status"
echo "  termux-agent status         - Check agent status"
echo "  termux-agent --help         - Show all commands"
echo ""
echo "Configuration:"
echo "  Config file: ~/.termux-agent/config.json"
echo "  Memory: ~/.termux-agent/memory/"
echo ""
echo "Need help?"
echo "  termux-agent --help"
echo "  Visit: https://github.com/termux-agent/termux-agent"
echo ""

# Add to bashrc if not already there
BASHRC="$HOME/.bashrc"
if [ -f "$BASHRC" ]; then
    if ! grep -q "termux-agent" "$BASHRC"; then
        echo -e "${BLUE}📝 Adding to ~/.bashrc...${NC}"
        echo "" >> "$BASHRC"
        echo "# TermuxAgent shortcuts" >> "$BASHRC"
        echo 'alias ta="termux-agent"' >> "$BASHRC"
        echo 'alias tachat="termux-agent chat"' >> "$BASHRC"
        echo "alias taask='termux-agent ask'" >> "$BASHRC"
    fi
fi

echo -e "${GREEN}🎉 All done! Type 'termux-agent --help' to get started.${NC}"
