package sample

import "context"

func discarded(parent context.Context) context.Context {
	ctx, _ := context.WithCancel(parent)
	return ctx
}

func unused(parent context.Context) context.Context {
	ctx, cancel := context.WithCancel(parent)
	return ctx
}
