output "bindings" {
  description = "infra:sync（Issue #5）の入力。terraform output -json bindings。"
  value       = module.env.bindings
  sensitive   = true
}
