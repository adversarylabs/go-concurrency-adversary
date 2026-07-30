package sample

import "context"

func owned(parent context.Context) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	_ = ctx
}

func transferred(parent context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(parent)
	return ctx, cancel
}
