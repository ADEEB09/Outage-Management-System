{{/*
Common labels applied to every resource -- lets you run
`kubectl get pods -l app.kubernetes.io/instance=oms` and see everything
belonging to this deployment in one shot.
*/}}
{{- define "oms.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "oms.backend.labels" -}}
{{ include "oms.labels" . }}
app.kubernetes.io/component: backend
{{- end -}}

{{- define "oms.frontend.labels" -}}
{{ include "oms.labels" . }}
app.kubernetes.io/component: frontend
{{- end -}}
