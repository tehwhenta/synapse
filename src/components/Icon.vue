<script setup>
import { computed } from 'vue'
import { Eye, EyeOff, TriangleAlert, Database, RefreshCw, Circle, CirclePause } from 'lucide-vue-next'
import { ArrowRight, ArrowUpRight, ArrowLeft, BookOpen, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, Clock3, Copy, Download, Edit3, FileText, Flame, Folder, Headphones, Home, Layers, LogOut, Menu, MessageCircle, Mic, MicOff, Monitor, MoreHorizontal, Pause, Play, Plus, Search, Settings2, ShieldCheck, Sparkles, Sprout, Timer, Trash2, Upload, Users, Video, VideoOff, X, Zap, RotateCcw, Link, LoaderCircle, List, ListOrdered, AlignLeft, AlignCenter, AlignRight, Table, Sigma, Undo2, Redo2, Highlighter, PenLine, Eraser, MessageSquarePlus, Maximize2, Minimize2, ArrowLeftRight, ArrowUpDown } from 'lucide-vue-next'
const props = defineProps({ name: String, size: { type: Number, default: 19 }, stroke: { type: Number, default: 1.7 } })
const icons = { ArrowRight, ArrowUpRight, ArrowLeft, BookOpen, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, Clock3, Copy, Download, Edit3, FileText, Flame, Folder, Headphones, Home, Layers, LogOut, Menu, MessageCircle, Mic, MicOff, Monitor, MoreHorizontal, Pause, Play, Plus, Search, Settings2, ShieldCheck, Sparkles, Sprout, Timer, Trash2, Upload, Users, Video, VideoOff, X, Zap, RotateCcw, Link, LoaderCircle, List, ListOrdered, AlignLeft, AlignCenter, AlignRight, Table, Sigma, Undo2, Redo2, Highlighter, PenLine, Eraser, MessageSquarePlus, Maximize2, Minimize2, ArrowLeftRight, ArrowUpDown }
const icon = computed(() => ({ Eye, EyeOff, TriangleAlert, Database, RefreshCw, Circle, CirclePause }[props.name]) || icons[props.name] || FileText)
</script>
<template><component :is="icon" :size="size" :stroke-width="stroke" aria-hidden="true" /></template>
