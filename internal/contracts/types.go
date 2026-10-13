package contracts

import "time"

const Version = "v1"

type Workspace struct {
	ID   string `json:"id" gorm:"primaryKey;size:64"`
	Name string `json:"name" gorm:"size:128"`
}

type Entity struct {
	UID               string            `json:"uid"`
	Kind              string            `json:"kind"`
	Name              string            `json:"name"`
	Namespace         string            `json:"namespace,omitempty"`
	NodeUID           string            `json:"nodeUid,omitempty"`
	ProviderID        string            `json:"providerId,omitempty"`
	Status            string            `json:"status"`
	CreatedAt         *time.Time        `json:"createdAt,omitempty"`
	Addresses         []string          `json:"addresses,omitempty"`
	Roles             []string          `json:"roles,omitempty"`
	Region            string            `json:"region,omitempty"`
	Zone              string            `json:"zone,omitempty"`
	OS                string            `json:"os,omitempty"`
	Kernel            string            `json:"kernel,omitempty"`
	KubeletVersion    string            `json:"kubeletVersion,omitempty"`
	ServiceType       string            `json:"serviceType,omitempty"`
	Ports             []ServicePort     `json:"ports,omitempty"`
	Hosts             []string          `json:"hosts,omitempty"`
	Conditions        []ObjectCondition `json:"conditions,omitempty"`
	CapacityCPU       *float64          `json:"capacityCpu,omitempty"`
	AllocatableCPU    *float64          `json:"allocatableCpu,omitempty"`
	CapacityMemory    *float64          `json:"capacityMemory,omitempty"`
	AllocatableMemory *float64          `json:"allocatableMemory,omitempty"`
	RequestedCPU      *float64          `json:"requestedCpu,omitempty"`
	LimitedCPU        *float64          `json:"limitedCpu,omitempty"`
	RequestedMemory   *float64          `json:"requestedMemory,omitempty"`
	LimitedMemory     *float64          `json:"limitedMemory,omitempty"`
	Desired           *int32            `json:"desired,omitempty"`
	Ready             *int32            `json:"ready,omitempty"`
	Restarts          int32             `json:"restarts,omitempty"`
	Containers        []ContainerState  `json:"containers,omitempty"`
	ResizeConditions  []ResizeCondition `json:"resizeConditions,omitempty"`
}

type ServicePort struct {
	Name     string `json:"name,omitempty"`
	Port     int32  `json:"port"`
	Protocol string `json:"protocol"`
}

type ObjectCondition struct {
	Type   string `json:"type"`
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
}

type ContainerState struct {
	Name            string   `json:"name"`
	Init            bool     `json:"init"`
	AppliedCPU      *float64 `json:"appliedCpu,omitempty"`
	AppliedMemory   *float64 `json:"appliedMemory,omitempty"`
	AllocatedCPU    *float64 `json:"allocatedCpu,omitempty"`
	AllocatedMemory *float64 `json:"allocatedMemory,omitempty"`
}
type ResizeCondition struct {
	Type           string    `json:"type"`
	Status         string    `json:"status"`
	Reason         string    `json:"reason,omitempty"`
	TransitionTime time.Time `json:"transitionTime"`
}

type Edge struct {
	Source   string `json:"source"`
	Target   string `json:"target"`
	Relation string `json:"relation"`
	Evidence string `json:"evidence"`
}

type Inventory struct {
	SourceTime   time.Time `json:"sourceTime"`
	Entities     []Entity  `json:"entities"`
	Edges        []Edge    `json:"edges"`
	Capabilities []string  `json:"capabilities"`
}

type Profile struct {
	Name            string     `json:"name"`
	ReturnProfile   string     `json:"returnProfile,omitempty"`
	Revision        uint64     `json:"revision"`
	AppliedRevision uint64     `json:"appliedRevision"`
	ExpiresAt       *time.Time `json:"expiresAt,omitempty"`
	NodeUIDs        []string   `json:"nodeUids"`
	Namespaces      []string   `json:"namespaces"`
	Paused          bool       `json:"paused"`
}

type Heartbeat struct {
	Version         string               `json:"version"`
	AppliedRevision uint64               `json:"appliedRevision"`
	QueueBytes      int64                `json:"queueBytes"`
	Dropped         uint64               `json:"dropped"`
	RejectedPoints  uint64               `json:"rejectedPoints"`
	Capabilities    []string             `json:"capabilities"`
	Outcome         string               `json:"outcome"`
	Nodes           []NodeAcknowledgment `json:"nodes,omitempty"`
}

// Observer control receipt and node application are deliberately separate.
type NodeAcknowledgment struct {
	NodeUID         string    `json:"nodeUid"`
	SeenAt          time.Time `json:"seenAt"`
	AppliedRevision uint64    `json:"appliedRevision"`
	Profile         string    `json:"profile"`
	Paused          bool      `json:"paused"`
	Dropped         uint64    `json:"dropped"`
}

type Receipt struct {
	ID            string    `json:"id"`
	Action        string    `json:"action"`
	ServerID      string    `json:"serverId"`
	NodeUID       string    `json:"nodeUid,omitempty"`
	Before        string    `json:"before"`
	After         string    `json:"after"`
	ObservedAt    time.Time `json:"observedAt"`
	CorrelationID string    `json:"correlationId"`
}
