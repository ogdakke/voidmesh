#!/bin/sh

# Install git hooks by symlinking from .githooks to .git/hooks
HOOK_DIR=".git/hooks"
SOURCE_DIR=".githooks"

echo "Installing git hooks..."

# Create symlink for pre-commit
ln -sf "../../${SOURCE_DIR}/pre-commit" "${HOOK_DIR}/pre-commit"

echo "✓ Git hooks installed successfully"
