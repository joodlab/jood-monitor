package main

import (
	"context"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	"time"
)

// Watches invalidate a bounded reconciliation; the 60s list also repairs missed changes.
// No event payload is logged or retained here.
func (o *observer) startWatches(ctx context.Context) {
	for _, gvr := range []schema.GroupVersionResource{
		{Version: "v1", Resource: "nodes"}, {Version: "v1", Resource: "pods"},
		{Group: "apps", Version: "v1", Resource: "deployments"},
		{Group: "apps", Version: "v1", Resource: "replicasets"},
		{Group: "apps", Version: "v1", Resource: "statefulsets"},
		{Group: "apps", Version: "v1", Resource: "daemonsets"},
		{Group: "autoscaling", Version: "v2", Resource: "horizontalpodautoscalers"},
		{Group: "discovery.k8s.io", Version: "v1", Resource: "endpointslices"},
		{Group: "networking.k8s.io", Version: "v1", Resource: "ingresses"},
		{Version: "v1", Resource: "services"},
		{Version: "v1", Resource: "events"},
	} {
		go o.watchResource(ctx, gvr)
	}
}
func (o *observer) watchResource(ctx context.Context, gvr schema.GroupVersionResource) {
	var revision string
	for ctx.Err() == nil {
		timeout := int64(300)
		stream, err := o.dynamic.Resource(gvr).Watch(ctx, metav1.ListOptions{ResourceVersion: revision, AllowWatchBookmarks: true, TimeoutSeconds: &timeout})
		if err == nil {
			for event := range stream.ResultChan() {
				if event.Type == watch.Error {
					revision = ""
					break
				}
				if object, ok := event.Object.(metav1.Object); ok {
					revision = object.GetResourceVersion()
				}
				if event.Type != watch.Bookmark {
					select {
					case o.dirty <- struct{}{}:
					default:
					}
				}
			}
			stream.Stop()
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}
