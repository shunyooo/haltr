#!/bin/bash
set -e

# Install dependencies if package.json exists
if [ -f "package.json" ]; then
    pnpm install
fi

# tmux settings
cat > ~/.tmux.conf << 'TMUX'
set -g mouse on

# Smooth scroll (1 line per scroll tick)
bind -T copy-mode WheelUpPane send-keys -X -N 1 scroll-up
bind -T copy-mode WheelDownPane send-keys -X -N 1 scroll-down
bind -T copy-mode-vi WheelUpPane send-keys -X -N 1 scroll-up
bind -T copy-mode-vi WheelDownPane send-keys -X -N 1 scroll-down
TMUX

echo ""
echo "=========================================="
echo "Development environment setup complete!"
echo "=========================================="
echo ""
echo "To start development:"
echo "  pnpm dev"
echo ""
echo "To build:"
echo "  pnpm build"
echo ""
echo "To run tests:"
echo "  pnpm test"
echo ""
